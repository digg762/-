'use strict';
// Хранилище Lutrix Game.
//  - Есть переменная DATABASE_URL (например, из Neon): всё лежит в Postgres и переживает перезапуски.
//  - Переменной нет (или не установился пакет pg): всё лежит в файле data/users.json.
//    На бесплатном Render такой файл стирается при каждом перезапуске.
//
// Живые данные держатся в памяти (объект mem), а хранилище только синхронизирует их.
// mark.*(id) говорит «эта запись изменилась или удалена»; flush() смотрит на текущее
// состояние в памяти и записывает его одной транзакцией (есть запись: сохранить,
// нет записи: удалить). Если база не отвечает, записи остаются «грязными» и
// повторяются каждые 5 секунд, а пока они не записаны, healthy() возвращает false.
const fs = require('fs');
const path = require('path');

class DbError extends Error { constructor(msg) { super(msg); this.dbError = true; } }

// коллекции-документы: имя -> Map(id -> объект)
const DOC_KINDS = ['offers', 'orders', 'ledger', 'meta'];

function newMem() {
  const mem = { users: {}, sessions: new Map() };
  for (const k of DOC_KINDS) mem[k] = new Map();
  return mem;
}

/* ===== файл ===== */
class FileStore {
  constructor(dir) {
    this.kind = 'file';
    this.dir = dir;
    this.file = path.join(dir, 'users.json');
    this.timer = null;
    this.mem = null;
  }
  async init(mem) {
    this.mem = mem;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (j && j.users) Object.assign(mem.users, j.users);
      if (j && j.sessions) for (const [h, s] of Object.entries(j.sessions)) if (s.exp > Date.now()) mem.sessions.set(h, s);
      for (const k of DOC_KINDS) if (j && j[k]) for (const [id, v] of Object.entries(j[k])) mem[k].set(id, v);
    } catch { /* файла ещё нет */ }
    process.on('SIGTERM', () => { this.flushNow(); process.exit(0); });
  }
  flushNow() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = this.file + '.tmp';
      const out = { users: this.mem.users, sessions: Object.fromEntries(this.mem.sessions) };
      for (const k of DOC_KINDS) out[k] = Object.fromEntries(this.mem[k]);
      fs.writeFileSync(tmp, JSON.stringify(out));
      fs.renameSync(tmp, this.file);
    } catch (e) { console.error('Не удалось сохранить данные:', e.message); }
  }
  healthy() { return true; }
  mark = { user() {}, session() {}, doc() {} };
  flush() { if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.flushNow(); }, 300); return Promise.resolve(); }
  touchUser() { return this.flush(); }
  touchSession() { return this.flush(); }
}

/* ===== Postgres ===== */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY, email text NOT NULL UNIQUE, data jsonb NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash text PRIMARY KEY, uid text NOT NULL, exp bigint NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sessions_uid_idx ON sessions (uid)`,
  `CREATE TABLE IF NOT EXISTS docs (kind text NOT NULL, id text NOT NULL, data jsonb NOT NULL, PRIMARY KEY (kind, id))`
];

class PgStore {
  constructor(url, Pool) {
    this.kind = 'postgres';
    const local = /@(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url) || /^postgres(ql)?:\/\/(localhost|127\.0\.0\.1)/.test(url);
    const cfg = { connectionString: url, max: 4, idleTimeoutMillis: 20000, connectionTimeoutMillis: 20000 };
    if (!local && !/sslmode=/.test(url)) cfg.ssl = { rejectUnauthorized: true };
    this.pool = new Pool(cfg);
    // без этого обрыв связи с базой (Neon усыпляет её при простое) мог бы уронить сервер
    this.pool.on('error', e => console.error('База: соединение закрыто, переподключимся сами:', e.message));
    this.dirty = { u: new Set(), s: new Set(), d: new Set() };
    this.chain = Promise.resolve();
    this.retryTimer = null;
    this.mem = null;
    const self = this;
    this.mark = {
      user: id => self.dirty.u.add(id),
      session: h => self.dirty.s.add(h),
      doc: (kind, id) => self.dirty.d.add(kind + '\u0000' + id)
    };
  }
  async init(mem) {
    this.mem = mem;
    for (const sql of SCHEMA) await this.pool.query(sql);
    const us = await this.pool.query('SELECT data FROM users');
    for (const r of us.rows) { const u = typeof r.data === 'string' ? JSON.parse(r.data) : r.data; mem.users[u.id] = u; }
    const ss = await this.pool.query('SELECT token_hash, uid, exp FROM sessions WHERE exp > $1', [Date.now()]);
    for (const r of ss.rows) mem.sessions.set(r.token_hash, { uid: r.uid, exp: Number(r.exp) });
    const ds = await this.pool.query('SELECT kind, id, data FROM docs');
    for (const r of ds.rows) if (mem[r.kind] instanceof Map) mem[r.kind].set(r.id, typeof r.data === 'string' ? JSON.parse(r.data) : r.data);
    process.on('SIGTERM', () => {
      const done = () => process.exit(0);
      setTimeout(done, 2500).unref();
      this.flush().catch(() => {}).finally(done);
    });
  }
  healthy() { return !this.dirty.u.size && !this.dirty.s.size && !this.dirty.d.size; }
  touchUser(id) { this.mark.user(id); return this.flush(); }
  touchSession(h) { this.mark.session(h); return this.flush(); }
  flush() {
    // записи идут строго по очереди, а в базу уходит самое свежее состояние из памяти
    const p = this.chain.catch(() => {}).then(() => this._run());
    this.chain = p;
    return p;
  }
  async _run() {
    const { mem, dirty } = this;
    if (!dirty.u.size && !dirty.s.size && !dirty.d.size) return;
    // забираем всё, что накопилось, и пишем одной транзакцией
    const us = [...dirty.u], ss = [...dirty.s], ds = [...dirty.d];
    dirty.u.clear(); dirty.s.clear(); dirty.d.clear();
    let client = null;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      for (const id of us) {
        const u = mem.users[id];
        if (u) await client.query(
          'INSERT INTO users (id, email, data) VALUES ($1, $2, $3::jsonb) ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, data = EXCLUDED.data',
          [u.id, u.email, JSON.stringify(u)]);
        else await client.query('DELETE FROM users WHERE id = $1', [id]);
      }
      for (const h of ss) {
        const s = mem.sessions.get(h);
        if (s) await client.query(
          'INSERT INTO sessions (token_hash, uid, exp) VALUES ($1, $2, $3) ON CONFLICT (token_hash) DO UPDATE SET uid = EXCLUDED.uid, exp = EXCLUDED.exp',
          [h, s.uid, s.exp]);
        else await client.query('DELETE FROM sessions WHERE token_hash = $1', [h]);
      }
      for (const key of ds) {
        const i = key.indexOf('\u0000'), kind = key.slice(0, i), id = key.slice(i + 1);
        const v = mem[kind] && mem[kind].get(id);
        if (v !== undefined) await client.query(
          'INSERT INTO docs (kind, id, data) VALUES ($1, $2, $3::jsonb) ON CONFLICT (kind, id) DO UPDATE SET data = EXCLUDED.data',
          [kind, id, JSON.stringify(v)]);
        else await client.query('DELETE FROM docs WHERE kind = $1 AND id = $2', [kind, id]);
      }
      await client.query('COMMIT');
      client.release();
    } catch (e) {
      if (client) { try { await client.query('ROLLBACK'); } catch { /* уже закрыто */ } client.release(true); }
      for (const x of us) dirty.u.add(x);
      for (const x of ss) dirty.s.add(x);
      for (const x of ds) dirty.d.add(x);
      console.error('База: не удалось записать, повторим через 5 секунд:', e.message);
      this._scheduleRetry();
      throw new DbError(e.message);
    }
  }
  _scheduleRetry() {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.flush().catch(() => {}); }, 5000);
    this.retryTimer.unref();
  }
}

// Выбор хранилища. Возвращает { store, note } (note: что написать в журнал).
function createStore(dataDir) {
  const url = (process.env.DATABASE_URL || '').trim();
  if (url) {
    let Pool = null;
    try { Pool = require('pg').Pool; } catch { /* пакета нет */ }
    if (Pool) return { store: new PgStore(url, Pool), note: 'Postgres (DATABASE_URL)' };
    return {
      store: new FileStore(dataDir),
      note: 'ФАЙЛ. DATABASE_URL задан, но пакет pg не установлен: на Render в Build Command впишите npm install и сделайте повторный деплой. Пока данные пропадают при перезапуске.'
    };
  }
  return { store: new FileStore(dataDir), note: 'файл (DATABASE_URL не задан, данные пропадают при перезапуске на Render)' };
}

module.exports = { createStore, DbError, newMem, DOC_KINDS };
