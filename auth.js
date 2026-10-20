// Lutrix Game: регистрация, вход, подтверждение почты кодом и восстановление пароля.
//
//  - Пользователи и входы хранятся в Postgres, если задана переменная DATABASE_URL
//    (см. store.js). Без неё: в файле data/users.json, а на бесплатном Render он
//    стирается при каждом перезапуске.
//  - Письма отправляет Brevo (бесплатно 300 писем в день, домен не нужен), если заданы
//    переменные BREVO_API_KEY и MAIL_FROM_EMAIL. Запасной вариант: Resend (RESEND_API_KEY).
//    Если не задано ничего, коды печатаются только в журнал (Logs) на Render.
//    Важно: бесплатный Render закрывает SMTP-порты, поэтому отправка идёт по HTTPS API.
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const { createStore, newMem } = require('./store');
const scrypt = promisify(crypto.scrypt);

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
// Brevo (основной сервис писем)
const BREVO_KEY = (process.env.BREVO_API_KEY || '').trim();
const MAIL_FROM_EMAIL = (process.env.MAIL_FROM_EMAIL || '').trim();            // подтверждённый отправитель в Brevo
const MAIL_FROM_NAME = (process.env.MAIL_FROM_NAME || 'Lutrix Game').trim();
const BREVO_BASE = process.env.BREVO_BASE || 'https://api.brevo.com';
// Resend (запасной вариант, нужен только если Brevo не настроен)
const RESEND_KEY = (process.env.RESEND_API_KEY || '').trim();
const MAIL_FROM = (process.env.MAIL_FROM || 'Lutrix Game <onboarding@resend.dev>').trim();
const RESEND_BASE = process.env.RESEND_BASE || 'https://api.resend.com';
// какой сервис реально используется
const MAIL_PROVIDER = BREVO_KEY && MAIL_FROM_EMAIL ? 'brevo' : RESEND_KEY ? 'resend' : '';
const MAIL_LIVE = !!MAIL_PROVIDER;
if (BREVO_KEY && !MAIL_FROM_EMAIL) console.warn('BREVO_API_KEY задан, но не задан MAIL_FROM_EMAIL (адрес отправителя, подтверждённый в Brevo): письма не отправляются.');

const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const CODE_TTL = 10 * MIN;          // код живёт 10 минут
const RESEND_GAP = 60 * 1000;       // новый код не чаще раза в минуту
const MAX_SENDS_PER_HOUR = 5;       // и не больше 5 писем в час на адрес (отдельно для регистрации и для сброса пароля)
const MAX_CODE_TRIES = 5;           // 5 неверных вводов, потом нужен новый код
const SESSION_TTL = 30 * DAY;
const MAX_USERS = 5000;
const COOKIE = 'lutrix_user';

/* ===== хранилище ===== */
const { store, note: storeNote } = createStore(DATA_DIR);
const mem = newMem(); // users, sessions (хэш токена -> { uid, exp }), offers, orders, ledger, meta
const byEmail = new Map();
let ready = false;

async function boot() {
  for (;;) {
    try {
      await store.init(mem);
      byEmail.clear();
      for (const u of Object.values(mem.users)) byEmail.set(u.email, u);
      ready = true;
      console.log(`Хранилище готово: ${store.kind}, пользователей: ${byEmail.size}`);
      return;
    } catch (e) {
      console.error('База недоступна, пробуем снова через 5 секунд:', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}
const booting = boot();
const quiet = e => console.error('Фоновая запись не удалась:', e.message);

/* ===== сессии ===== */
const sha = v => crypto.createHash('sha256').update(v).digest('hex');
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
  const h = sha(t), s = mem.sessions.get(h);
  if (!s || s.exp < Date.now()) { if (s) { mem.sessions.delete(h); store.touchSession(h).catch(quiet); } return null; }
  const u = mem.users[s.uid];
  return u && u.verified ? u : null;
}
async function startSession(req, res, u) {
  const token = crypto.randomBytes(32).toString('hex'), h = sha(token);
  mem.sessions.set(h, { uid: u.id, exp: Date.now() + SESSION_TTL });
  // если база не отвечает, вход всё равно работает: сессия лежит в памяти и допишется в базу сама
  try { await store.touchSession(h); }
  catch (e) { if (!e.dbError) { mem.sessions.delete(h); throw e; } }
  setCookie(req, res, token, SESSION_TTL / 1000);
}
async function dropSessions(uid) {
  const hs = [];
  for (const [h, s] of mem.sessions) if (s.uid === uid) { mem.sessions.delete(h); hs.push(h); }
  for (const h of hs) await store.touchSession(h);
}
const pub = u => ({ id: u.id, email: u.email, name: u.name, balance: u.bal || 0, owner: !!u.owner, av: u.avv || 0 });

setInterval(() => {
  if (!ready) return;
  const now = Date.now();
  for (const [h, s] of mem.sessions) if (s.exp < now) { mem.sessions.delete(h); store.touchSession(h).catch(quiet); }
  for (const u of Object.values(mem.users)) {
    if (!u.verified && now - u.createdAt > DAY) { delete mem.users[u.id]; byEmail.delete(u.email); store.touchUser(u.id).catch(quiet); }
  }
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
// два вида кодов: 'code' (подтверждение почты) и 'reset' (смена пароля); хранятся отдельно
const KINDS = {
  code:  { slot: 'code',  sends: 'sends',  salt: '' },
  reset: { slot: 'reset', sends: 'rsends', salt: 'reset:' }
};
const hashCode = (kind, uid, code) => crypto.createHash('sha256').update(KINDS[kind].salt + uid + ':' + code).digest('hex');
function codeMatches(u, kind, code) {
  const a = Buffer.from(hashCode(kind, u.id, code), 'hex'), b = Buffer.from(u[KINDS[kind].slot].hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ===== письма ===== */
const MAILS = {
  code: {
    subject: 'Код подтверждения Lutrix Game', title: 'Ваш код подтверждения:',
    tail: 'Если вы не регистрировались на Lutrix Game, просто проигнорируйте это письмо.',
    dev: 'Код подтверждения'
  },
  reset: {
    subject: 'Восстановление пароля Lutrix Game', title: 'Код для смены пароля:',
    tail: 'Если вы не просили сменить пароль, просто проигнорируйте это письмо: ваш пароль останется прежним.',
    dev: 'Код восстановления пароля'
  }
};
async function sendMail(kind, email, code) {
  const m = MAILS[kind];
  if (!MAIL_LIVE) {
    console.log(`[ПОЧТА НЕ ПОДКЛЮЧЕНА] ${m.dev} для ${email}: ${code}`);
    return 'dev';
  }
  const text = `${m.title} ${code}\nОн действует 10 минут. ${m.tail}`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:420px;margin:0 auto;padding:24px"><h2 style="margin:0 0 12px">Lutrix Game</h2><p>${m.title}</p><p style="font-size:32px;letter-spacing:8px;font-weight:700;margin:12px 0">${code}</p><p style="color:#666;font-size:14px">Код действует 10 минут. ${m.tail}</p></div>`;
  let r, name;
  if (MAIL_PROVIDER === 'brevo') {
    name = 'Brevo';
    r = await fetch(BREVO_BASE + '/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: MAIL_FROM_NAME, email: MAIL_FROM_EMAIL },
        to: [{ email }],
        subject: m.subject, htmlContent: html, textContent: text
      }),
      signal: AbortSignal.timeout(15000)
    });
  } else {
    name = 'Resend';
    r = await fetch(RESEND_BASE + '/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [email], subject: m.subject, html, text }),
      signal: AbortSignal.timeout(15000)
    });
  }
  if (!r.ok) {
    let t = ''; try { t = (await r.text()).slice(0, 300); } catch { /* пусто */ }
    throw new Error(name + ' ответил ' + r.status + ' ' + t);
  }
  return 'sent';
}

function canSend(u, kind) {
  const { slot, sends } = KINDS[kind], now = Date.now();
  u[sends] = (u[sends] || []).filter(t => now - t < HOUR);
  if (u[slot] && now - u[slot].sentAt < RESEND_GAP) return { ok: false, wait: Math.ceil((RESEND_GAP - (now - u[slot].sentAt)) / 1000) };
  if (u[sends].length >= MAX_SENDS_PER_HOUR) return { ok: false, wait: Math.ceil((HOUR - (now - u[sends][0])) / 1000) };
  return { ok: true };
}
async function issueCode(u, kind) {
  const { slot, sends } = KINDS[kind];
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  u[slot] = { hash: hashCode(kind, u.id, code), exp: Date.now() + CODE_TTL, tries: 0, sentAt: Date.now() };
  u[sends] = u[sends] || [];
  u[sends].push(Date.now());
  const undo = () => { if (u[slot]) u[slot].sentAt = 0; u[sends].pop(); }; // при сбое можно сразу попробовать снова
  try { await store.touchUser(u.id); } catch (e) { undo(); throw e; }
  try { return await sendMail(kind, u.email, code); }
  catch (e) { undo(); store.touchUser(u.id).catch(quiet); throw e; }
}
const waitText = s => s >= 90 ? `Подождите ${Math.ceil(s / 60)} мин.` : `Подождите ${s} с.`;

/* ===== запросы ===== */
function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(obj));
}
const fail = (res, status, error, message, extra) => send(res, status, Object.assign({ error, message }, extra || {}));
const mailFail = (res, e) => { console.error('Не удалось отправить письмо:', e.message); return fail(res, 502, 'mail_failed', 'Не удалось отправить письмо. Попробуйте ещё раз чуть позже.'); };

async function readJson(req, ctx) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return { bad: 415 };
  try { return { body: JSON.parse(await ctx.readBody(req, 4096)) || {} }; } catch { return { bad: 400 }; }
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const NAME_RE = /^[\p{L}\p{N} ._-]{2,24}$/u;
const normEmail = v => String(v || '').trim().toLowerCase();
const ROUTES = ['register', 'verify', 'resend', 'login', 'logout', 'logout-all', 'forgot', 'reset'];

async function handle(req, res, url, ctx) {
  try { return await route(req, res, url, ctx); }
  catch (e) {
    if (e && e.dbError && !res.headersSent) return fail(res, 503, 'db_down', 'База данных временно недоступна. Попробуйте через минуту.');
    throw e;
  }
}

async function route(req, res, url, ctx) {
  const name_ = url.pathname.slice('/api/auth/'.length);
  const ip = ctx.clientIp(req);
  if (name_ !== 'me' && !ROUTES.includes(name_)) return fail(res, 404, 'not_found', 'Не найдено');
  if (!ready) return fail(res, 503, 'db_down', 'Сервис запускается, попробуйте через несколько секунд.');

  if (name_ === 'me') {
    if (req.method !== 'GET') return fail(res, 405, 'method', 'Метод не поддерживается');
    const u = userFromReq(req);
    return send(res, 200, { user: u ? pub(u) : null, mail: MAIL_LIVE ? 'live' : 'dev' });
  }
  if (req.method !== 'POST') return fail(res, 405, 'method', 'Метод не поддерживается');

  if (name_ === 'logout' || name_ === 'logout-all') {
    const u = userFromReq(req);
    const t = parseCookies(req)[COOKIE];
    try {
      if (name_ === 'logout-all' && u) await dropSessions(u.id);
      else if (t && /^[a-f0-9]{64}$/.test(t)) { const h = sha(t); mem.sessions.delete(h); await store.touchSession(h); }
    } catch (e) { console.error('Выход: запись не удалась:', e.message); }
    setCookie(req, res, '', 0);
    return send(res, 200, { ok: true });
  }

  const parsed = await readJson(req, ctx);
  if (parsed.bad) return fail(res, parsed.bad, 'bad_request', 'Некорректный запрос');
  const b = parsed.body;
  const email = normEmail(b.email);

  if (name_ === 'register') {
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
    if (!u && byEmail.size >= MAX_USERS) return fail(res, 503, 'full', 'Регистрация временно закрыта.');
    if (u) { const c = canSend(u, 'code'); if (!c.ok) return fail(res, 429, 'wait', 'Код уже отправлен. ' + waitText(c.wait), { wait: c.wait }); }
    const hash = await hashPassword(password);
    if (!u) {
      u = { id: crypto.randomBytes(8).toString('hex'), email, createdAt: Date.now(), verified: false, sends: [], bal: 0 };
      mem.users[u.id] = u; byEmail.set(email, u);
    }
    u.name = name; u.hash = hash;
    try { const mail = await issueCode(u, 'code'); return send(res, 200, { ok: true, step: 'verify', mail }); }
    catch (e) { if (e.dbError) throw e; return mailFail(res, e); }
  }

  if (name_ === 'verify') {
    if (ctx.blocked('ver:' + ip, 20, 10 * MIN)) return fail(res, 429, 'too_many', 'Слишком много попыток. Подождите 10 минут.');
    ctx.bump('ver:' + ip, 10 * MIN);
    const code = String(b.code || '').trim();
    const u = byEmail.get(email);
    const bad = () => fail(res, 400, 'bad_code', 'Код неверный или устарел. Запросите новый.');
    if (!u || u.verified || !u.code || !/^\d{6}$/.test(code)) return bad();
    if (u.code.exp < Date.now() || u.code.tries >= MAX_CODE_TRIES) return bad();
    if (!codeMatches(u, 'code', code)) { u.code.tries += 1; await store.touchUser(u.id); return bad(); }
    u.verified = true; u.code = null; u.verifiedAt = Date.now();
    await store.touchUser(u.id);
    await startSession(req, res, u);
    return send(res, 200, { ok: true, user: pub(u) });
  }

  if (name_ === 'resend') {
    if (ctx.blocked('rs:' + ip, 10, HOUR)) return fail(res, 429, 'too_many', 'Слишком много запросов. Попробуйте позже.');
    ctx.bump('rs:' + ip, HOUR);
    const u = byEmail.get(email);
    if (!u || u.verified) return send(res, 200, { ok: true }); // не раскрываем, есть ли такой адрес
    const c = canSend(u, 'code');
    if (!c.ok) return fail(res, 429, 'wait', waitText(c.wait), { wait: c.wait });
    try { const mail = await issueCode(u, 'code'); return send(res, 200, { ok: true, mail }); }
    catch (e) { if (e.dbError) throw e; return mailFail(res, e); }
  }

  if (name_ === 'login') {
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
      const c = canSend(u, 'code');
      if (!c.ok) return fail(res, 403, 'not_verified', 'Почта не подтверждена. Введите последний присланный код. ' + waitText(c.wait));
      try { const mail = await issueCode(u, 'code'); return fail(res, 403, 'not_verified', 'Почта не подтверждена. Мы отправили новый код.', { mail }); }
      catch (e) { if (e.dbError) throw e; return mailFail(res, e); }
    }
    await startSession(req, res, u);
    return send(res, 200, { ok: true, user: pub(u) });
  }

  if (name_ === 'forgot') {
    if (ctx.blocked('fg:' + ip, 10, HOUR)) return fail(res, 429, 'too_many', 'Слишком много запросов. Попробуйте позже.');
    ctx.bump('fg:' + ip, HOUR);
    if (email.length > 254 || !EMAIL_RE.test(email)) return fail(res, 400, 'bad_email', 'Проверьте адрес почты.');
    // ответ всегда одинаковый и сразу: так по нему не узнать, зарегистрирована ли почта
    send(res, 200, { ok: true, mail: MAIL_LIVE ? 'sent' : 'dev' });
    const u = byEmail.get(email);
    if (u && u.verified && canSend(u, 'reset').ok) issueCode(u, 'reset').catch(e => console.error('Письмо для сброса пароля не ушло:', e.message));
    return;
  }

  if (name_ === 'reset') {
    if (ctx.blocked('rst:' + ip, 20, 10 * MIN)) return fail(res, 429, 'too_many', 'Слишком много попыток. Подождите 10 минут.');
    ctx.bump('rst:' + ip, 10 * MIN);
    const code = String(b.code || '').trim();
    const password = String(b.password || '');
    if (password.length < 8 || password.length > 128) return fail(res, 400, 'bad_password', 'Пароль: от 8 до 128 символов.');
    if (password.toLowerCase() === email) return fail(res, 400, 'bad_password', 'Пароль не должен совпадать с почтой.');
    const u = byEmail.get(email);
    const bad = () => fail(res, 400, 'bad_code', 'Код неверный или устарел. Запросите новый.');
    if (!u || !u.verified || !u.reset || !/^\d{6}$/.test(code)) return bad();
    if (u.reset.exp < Date.now() || u.reset.tries >= MAX_CODE_TRIES) return bad();
    if (!codeMatches(u, 'reset', code)) { u.reset.tries += 1; await store.touchUser(u.id); return bad(); }
    u.reset = null; // код одноразовый, второй такой же запрос уже не пройдёт
    u.hash = await hashPassword(password);
    u.passwordChangedAt = Date.now();
    await dropSessions(u.id);               // все старые входы на других устройствах закрываются
    await store.touchUser(u.id);
    await startSession(req, res, u);
    return send(res, 200, { ok: true, user: pub(u) });
  }
}

module.exports = {
  handle, mode: MAIL_LIVE ? 'live' : 'dev', provider: MAIL_PROVIDER, storeNote,
  // внутренности для market.js
  core: { mem, store, byEmail, userFromReq, pub, isReady: () => ready, parseCookies }
};
