'use strict';
// Lootly: регистрация, вход и подтверждение почты кодом.
//
// Как это работает сейчас:
//  - пользователи хранятся в файле data/users.json (на бесплатном Render файл стирается
//    при каждом перезапуске и после 15 минут без посетителей, это временное решение,
//    дальше нужна база данных);
//  - письма отправляет Resend, если задана переменная RESEND_API_KEY;
//    без неё код подтверждения печатается только в журнал (Logs) на Render.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'users.json');
const RESEND_KEY = (process.env.RESEND_API_KEY || '').trim();
const MAIL_FROM = (process.env.MAIL_FROM || 'Lootly <onboarding@resend.dev>').trim();
const RESEND_BASE = process.env.RESEND_BASE || 'https://api.resend.com';

const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const CODE_TTL = 10 * MIN;          // код живёт 10 минут
const RESEND_GAP = 60 * 1000;       // новый код не чаще раза в минуту
const MAX_SENDS_PER_HOUR = 5;       // и не больше 5 писем в час на адрес
const MAX_CODE_TRIES = 5;           // 5 неверных вводов, потом нужен новый код
const SESSION_TTL = 30 * DAY;
const MAX_USERS = 5000;
const COOKIE = 'lootly_user';

/* ===== хранилище ===== */
let db = { users: {} };
try { const j = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); if (j && j.users) db = j; } catch { /* файла ещё нет */ }
const byEmail = new Map();
for (const u of Object.values(db.users)) byEmail.set(u.email, u);

function flush() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) { console.error('Не удалось сохранить пользователей:', e.message); }
}
let timer = null;
function persist() { if (!timer) timer = setTimeout(() => { timer = null; flush(); }, 300); }
process.on('SIGTERM', () => { if (timer) { clearTimeout(timer); flush(); } process.exit(0); });

/* ===== сессии ===== */
const sessions = new Map(); // токен -> { uid, exp }
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* битая кука */ } }
  }
  return out;
}
const isHttps = req => String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
function setCookie(req, res, token, maxAgeSec) {
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${isHttps(req) ? '; Secure' : ''}`);
}
function userFromReq(req) {
  const t = parseCookies(req)[COOKIE];
  if (!t || !/^[a-f0-9]{64}$/.test(t)) return null;
  const s = sessions.get(t);
  if (!s || s.exp < Date.now()) { sessions.delete(t); return null; }
  const u = db.users[s.uid];
  return u && u.verified ? u : null;
}
function startSession(req, res, u) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { uid: u.id, exp: Date.now() + SESSION_TTL });
  setCookie(req, res, token, SESSION_TTL / 1000);
}
const pub = u => ({ id: u.id, email: u.email, name: u.name });

setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (s.exp < now) sessions.delete(t);
  let removed = false;
  for (const u of Object.values(db.users)) {
    if (!u.verified && now - u.createdAt > DAY) { delete db.users[u.id]; byEmail.delete(u.email); removed = true; }
  }
  if (removed) persist();
}, 10 * MIN).unref();

/* ===== пароли и коды ===== */
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(pw, salt, 64);
  return salt.toString('hex') + ':' + h.toString('hex');
}
const DUMMY_SALT = crypto.randomBytes(16);
async function checkPassword(pw, stored) {
  const [s, h] = String(stored).split(':');
  const got = await scrypt(pw, Buffer.from(s, 'hex'), 64);
  const want = Buffer.from(h, 'hex');
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
const hashCode = (uid, code) => crypto.createHash('sha256').update(uid + ':' + code).digest('hex');
function codeMatches(u, code) {
  const a = Buffer.from(hashCode(u.id, code), 'hex'), b = Buffer.from(u.code.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ===== письма ===== */
async function sendCodeMail(email, code) {
  if (!RESEND_KEY) {
    console.log(`[ПОЧТА НЕ ПОДКЛЮЧЕНА] Код подтверждения для ${email}: ${code}`);
    return 'dev';
  }
  const text = `Ваш код подтверждения Lootly: ${code}\nОн действует 10 минут. Если вы не регистрировались на Lootly, просто проигнорируйте это письмо.`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:420px;margin:0 auto;padding:24px"><h2 style="margin:0 0 12px">Lootly</h2><p>Ваш код подтверждения:</p><p style="font-size:32px;letter-spacing:8px;font-weight:700;margin:12px 0">${code}</p><p style="color:#666;font-size:14px">Код действует 10 минут. Если вы не регистрировались на Lootly, просто проигнорируйте это письмо.</p></div>`;
  const r = await fetch(RESEND_BASE + '/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: MAIL_FROM, to: [email], subject: 'Код подтверждения Lootly', html, text }),
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) {
    let t = ''; try { t = (await r.text()).slice(0, 300); } catch { /* пусто */ }
    throw new Error('Resend ответил ' + r.status + ' ' + t);
  }
  return 'sent';
}

function canSend(u) {
  const now = Date.now();
  u.sends = (u.sends || []).filter(t => now - t < HOUR);
  if (u.code && now - u.code.sentAt < RESEND_GAP) return { ok: false, wait: Math.ceil((RESEND_GAP - (now - u.code.sentAt)) / 1000) };
  if (u.sends.length >= MAX_SENDS_PER_HOUR) return { ok: false, wait: Math.ceil((HOUR - (now - u.sends[0])) / 1000) };
  return { ok: true };
}
async function issueCode(u) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  u.code = { hash: hashCode(u.id, code), exp: Date.now() + CODE_TTL, tries: 0, sentAt: Date.now() };
  u.sends = u.sends || [];
  u.sends.push(Date.now());
  persist();
  try { return await sendCodeMail(u.email, code); }
  catch (e) { u.code.sentAt = 0; u.sends.pop(); persist(); throw e; } // при сбое можно сразу попробовать снова
}
const waitText = s => s >= 90 ? `Подождите ${Math.ceil(s / 60)} мин.` : `Подождите ${s} с.`;

/* ===== запросы ===== */
function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(obj));
}
const fail = (res, status, error, message, extra) => send(res, status, Object.assign({ error, message }, extra || {}));

async function readJson(req, ctx) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return { bad: 415 };
  try { return { body: JSON.parse(await ctx.readBody(req, 4096)) || {} }; } catch { return { bad: 400 }; }
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const NAME_RE = /^[\p{L}\p{N} ._-]{2,24}$/u;
const normEmail = v => String(v || '').trim().toLowerCase();

async function handle(req, res, url, ctx) {
  const route = url.pathname.slice('/api/auth/'.length);
  const ip = ctx.clientIp(req);

  if (route === 'me') {
    if (req.method !== 'GET') return fail(res, 405, 'method', 'Метод не поддерживается');
    const u = userFromReq(req);
    return send(res, 200, { user: u ? pub(u) : null, mail: RESEND_KEY ? 'live' : 'dev' });
  }
  if (!['register', 'verify', 'resend', 'login', 'logout', 'logout-all'].includes(route)) return fail(res, 404, 'not_found', 'Не найдено');
  if (req.method !== 'POST') return fail(res, 405, 'method', 'Метод не поддерживается');

  if (route === 'logout' || route === 'logout-all') {
    const u = userFromReq(req);
    const t = parseCookies(req)[COOKIE];
    if (route === 'logout-all' && u) { for (const [k, s] of sessions) if (s.uid === u.id) sessions.delete(k); }
    else if (t) sessions.delete(t);
    setCookie(req, res, '', 0);
    return send(res, 200, { ok: true });
  }

  const parsed = await readJson(req, ctx);
  if (parsed.bad) return fail(res, parsed.bad, 'bad_request', 'Некорректный запрос');
  const b = parsed.body;
  const email = normEmail(b.email);

  if (route === 'register') {
    if (ctx.blocked('reg:' + ip, 10, HOUR)) return fail(res, 429, 'too_many', 'Слишком много попыток регистрации. Попробуйте позже.');
    ctx.bump('reg:' + ip, HOUR);
    const name = String(b.name || '').trim();
    const password = String(b.password || '');
    if (!NAME_RE.test(name)) return fail(res, 400, 'bad_name', 'Никнейм: от 2 до 24 символов, буквы, цифры, пробел, точка, дефис или подчёркивание.');
    if (email.length > 254 || !EMAIL_RE.test(email)) return fail(res, 400, 'bad_email', 'Проверьте адрес почты.');
    if (password.length < 8 || password.length > 128) return fail(res, 400, 'bad_password', 'Пароль: от 8 до 128 символов.');
    if (password.toLowerCase() === email) return fail(res, 400, 'bad_password', 'Пароль не должен совпадать с почтой.');
    let u = byEmail.get(email);
    if (u && u.verified) return fail(res, 409, 'exists', 'Эта почта уже зарегистрирована. Нажмите «Войти».');
    if (!u && Object.keys(db.users).length >= MAX_USERS) return fail(res, 503, 'full', 'Регистрация временно закрыта.');
    if (u) { const c = canSend(u); if (!c.ok) return fail(res, 429, 'wait', 'Код уже отправлен. ' + waitText(c.wait), { wait: c.wait }); }
    const hash = await hashPassword(password);
    if (!u) {
      u = { id: crypto.randomBytes(8).toString('hex'), email, createdAt: Date.now(), verified: false, sends: [] };
      db.users[u.id] = u; byEmail.set(email, u);
    }
    u.name = name; u.hash = hash;
    try { const mail = await issueCode(u); return send(res, 200, { ok: true, step: 'verify', mail }); }
    catch (e) { console.error('Не удалось отправить письмо:', e.message); return fail(res, 502, 'mail_failed', 'Не удалось отправить письмо. Попробуйте ещё раз чуть позже.'); }
  }

  if (route === 'verify') {
    if (ctx.blocked('ver:' + ip, 20, 10 * MIN)) return fail(res, 429, 'too_many', 'Слишком много попыток. Подождите 10 минут.');
    ctx.bump('ver:' + ip, 10 * MIN);
    const code = String(b.code || '').trim();
    const u = byEmail.get(email);
    const bad = () => fail(res, 400, 'bad_code', 'Код неверный или устарел. Запросите новый.');
    if (!u || u.verified || !u.code || !/^\d{6}$/.test(code)) return bad();
    if (u.code.exp < Date.now() || u.code.tries >= MAX_CODE_TRIES) return bad();
    if (!codeMatches(u, code)) { u.code.tries += 1; persist(); return bad(); }
    u.verified = true; u.code = null; u.verifiedAt = Date.now(); persist();
    startSession(req, res, u);
    return send(res, 200, { ok: true, user: pub(u) });
  }

  if (route === 'resend') {
    if (ctx.blocked('rs:' + ip, 10, HOUR)) return fail(res, 429, 'too_many', 'Слишком много запросов. Попробуйте позже.');
    ctx.bump('rs:' + ip, HOUR);
    const u = byEmail.get(email);
    if (!u || u.verified) return send(res, 200, { ok: true }); // не раскрываем, есть ли такой адрес
    const c = canSend(u);
    if (!c.ok) return fail(res, 429, 'wait', waitText(c.wait), { wait: c.wait });
    try { const mail = await issueCode(u); return send(res, 200, { ok: true, mail }); }
    catch (e) { console.error('Не удалось отправить письмо:', e.message); return fail(res, 502, 'mail_failed', 'Не удалось отправить письмо. Попробуйте ещё раз чуть позже.'); }
  }

  if (route === 'login') {
    const k1 = 'login:' + ip, k2 = 'login:' + ip + ':' + email;
    if (ctx.blocked(k1, 30, 10 * MIN) || ctx.blocked(k2, 8, 10 * MIN)) return fail(res, 429, 'too_many', 'Слишком много попыток входа. Подождите 10 минут.');
    const password = String(b.password || '').slice(0, 128);
    const u = byEmail.get(email);
    let ok = false;
    if (u) ok = await checkPassword(password, u.hash);
    else await scrypt(password, DUMMY_SALT, 64); // одинаковое время ответа для неизвестной почты
    if (!ok) { ctx.bump(k1, 10 * MIN); ctx.bump(k2, 10 * MIN); return fail(res, 401, 'bad_login', 'Неверная почта или пароль.'); }
    ctx.clear(k2);
    if (!u.verified) {
      const c = canSend(u);
      if (!c.ok) return fail(res, 403, 'not_verified', 'Почта не подтверждена. Введите последний присланный код. ' + waitText(c.wait));
      try { const mail = await issueCode(u); return fail(res, 403, 'not_verified', 'Почта не подтверждена. Мы отправили новый код.', { mail }); }
      catch (e) { console.error('Не удалось отправить письмо:', e.message); return fail(res, 502, 'mail_failed', 'Не удалось отправить письмо. Попробуйте ещё раз чуть позже.'); }
    }
    startSession(req, res, u);
    return send(res, 200, { ok: true, user: pub(u) });
  }
}

module.exports = { handle, mode: RESEND_KEY ? 'live' : 'dev', dataFile: DB_FILE };
