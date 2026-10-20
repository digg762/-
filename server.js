'use strict';
// Lutrix Game: статический сайт + прокси обложек RAWG. Ключ живёт только в переменной окружения RAWG_KEY.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const auth = require('./auth');
const market = require('./market');

/* ============================================================
   ПАРОЛЬ НА ВХОД НА САЙТ
   ------------------------------------------------------------
   Меняй пароль прямо тут, в кавычках (переменная SITE_PASSWORD),
   либо задай переменную окружения SITE_PASSWORD на Render —
   тогда значение из кода использоваться не будет.
   Пока пароль не введён, сайт никому не открывается:
   все страницы и все /api/* закрыты сервером.
   ============================================================ */
const SITE_PASSWORD = (process.env.SITE_PASSWORD || 'lutrix-parol-2026').trim();

const PORT = process.env.PORT || 3000;
const KEY = (process.env.RAWG_KEY || '').trim();
const BASE = process.env.RAWG_BASE || 'https://api.rawg.io';
const CLIENT = (process.env.BRANDFETCH_CLIENT_ID || '').trim();
const PUBLIC = path.join(__dirname, 'public');
const DAY = 24 * 3600 * 1000;

// id -> название (только игры)
const games = new Map();
for (const line of fs.readFileSync(path.join(__dirname, 'games.txt'), 'utf8').split('\n')) {
  if (!line.trim() || line.startsWith('#')) continue;
  const i = line.indexOf('|');
  games.set(line.slice(0, i), line.slice(i + 1).trim());
}

// id -> домен сайта приложения (для логотипов Brandfetch)
const apps = new Map();
for (const line of fs.readFileSync(path.join(__dirname, 'apps.txt'), 'utf8').split('\n')) {
  if (!line.trim() || line.startsWith('#')) continue;
  const [id, , domain] = line.split('|');
  if (domain && domain.trim()) apps.set(id, domain.trim());
}

// сколько всего позиций (игры + приложения): ид идут подряд от 0
let totalItems = 0;
for (const k of [...games.keys(), ...fs.readFileSync(path.join(__dirname, 'apps.txt'), 'utf8').split('\n').filter(l => /^\d/.test(l)).map(l => l.split('|')[0])]) totalItems = Math.max(totalItems, +k + 1);

// магазин игр: цены берём из того же списка, что показывается на сайте, чтобы они не расходились
const shop = [];
{
  const m = /const SHOP_LIST = `([^`]*)`/.exec(fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'));
  for (const l of (m ? m[1] : '').split('\n')) {
    const [name, , price, , d] = l.split('|');
    if (name) shop.push({ name, price: Math.round(Math.round(+price * (1 - +d / 100)) * 100) });
  }
}

const norm = s => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function similarity(a, b) {
  a = norm(a); b = norm(b);
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = s => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); m.set(k, (m.get(k) || 0) + 1); } return m; };
  const A = grams(a), B = grams(b); let hit = 0;
  for (const [k, v] of A) hit += Math.min(v, B.get(k) || 0);
  return (2 * hit) / (a.length + b.length - 2);
}

// не больше 3 одновременных запросов к RAWG
let active = 0; const waiting = [];
function limit(fn) {
  return new Promise((resolve, reject) => {
    const run = () => { active++; fn().then(resolve, reject).finally(() => { active--; const n = waiting.shift(); if (n) n(); }); };
    active < 3 ? run() : waiting.push(run);
  });
}

const cache = new Map();    // id -> { url, at }
const inflight = new Map(); // id -> Promise

/* ===== Защита паролем: сессии, куки, страница входа ===== */
const COOKIE = 'lutrix_auth';
const WEEK = 7 * DAY;
// Вход по паролю подписан секретом и сам хранит срок действия, поэтому
// переживает перезапуск и «засыпание» Render: заново вводить пароль не придётся.
// Подпись зависит от SITE_PASSWORD: сменили пароль, и все старые входы перестали работать.
const GATE_KEY = crypto.createHash('sha256').update('lutrix-gate:' + (process.env.SESSION_SECRET || '') + ':' + SITE_PASSWORD).digest();
const gateSign = exp => crypto.createHmac('sha256', GATE_KEY).update(String(exp)).digest('hex');
const gateToken = exp => exp + '.' + gateSign(exp);

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  const t = parseCookies(req)[COOKIE];
  const m = /^(\d{10,15})\.([a-f0-9]{64})$/.exec(t || '');
  if (!m || Number(m[1]) < Date.now()) return false;
  const a = Buffer.from(m[2], 'hex'), b = Buffer.from(gateSign(m[1]), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ограничение попыток: счётчики по ключу (IP, адрес почты и т.п.)
const MIN = 60 * 1000;
const buckets = new Map(); // key -> { n, reset }
function bucket(key, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  return b;
}
const blocked = (key, max, windowMs) => bucket(key, windowMs).n >= max;
const bump = (key, windowMs) => { bucket(key, windowMs).n += 1; };
const clearBucket = key => { buckets.delete(key); };
// адрес посетителя: последний в X-Forwarded-For дописывает сам Render, подделать его нельзя
function clientIp(req) {
  const x = String(req.headers['x-forwarded-for'] || '').split(',').map(v => v.trim()).filter(Boolean);
  return x.length ? x[x.length - 1] : (req.socket.remoteAddress || '?');
}
const isHttps = req => String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k);
}, 60000).unref();

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > limit) { reject(new Error('body too big')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function setSessionCookie(req, res, token, maxAge) {
  res.setHeader('Set-Cookie', COOKIE + '=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + (isHttps(req) ? '; Secure' : ''));
}

const LOGIN_PAGE = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Lutrix Game</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600;700&family=Unbounded:wght@500;700&display=swap">
<style>
:root{--bg:#090911;--surface:#12121e;--surface-2:#1a1a2a;--surface-3:#242439;--line:#2a2a40;--fg:#eef0fc;--muted:#9b9db8;--blue:#4da3ff;--violet:#9a5cff;--grad:linear-gradient(100deg,var(--blue),var(--violet));--on-grad:#07070f;--bad:#ff5d73;--shadow:0 14px 40px rgba(0,0,0,.45);color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--fg);font-family:'Onest',system-ui,sans-serif;display:grid;place-items:center;padding:16px;-webkit-font-smoothing:antialiased}
body::before{content:"";position:fixed;inset:0;background:radial-gradient(60% 50% at 50% 0%,rgba(122,92,255,.16),transparent 70%);pointer-events:none}
.card{width:min(400px,100%);background:var(--surface);border:1px solid var(--line);border-radius:20px;padding:28px 26px;box-shadow:var(--shadow);display:flex;flex-direction:column;gap:16px;position:relative}
.logo{font-family:'Unbounded',sans-serif;font-weight:700;font-size:30px;letter-spacing:-.03em;text-align:center;background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{text-align:center;color:var(--muted);font-size:14px;margin-top:-10px}
label{font-weight:600;font-size:14px;display:flex;flex-direction:column;gap:6px}
input{background:var(--surface-2);border:1px solid var(--line);border-radius:12px;padding:11px 14px;color:var(--fg);font:inherit;outline:none;width:100%}
input:focus{border-color:var(--blue)}
button{font:inherit;cursor:pointer}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:0;background:var(--grad);color:var(--on-grad);padding:11px 16px;border-radius:12px;font-weight:700;width:100%}
.btn:hover{filter:brightness(1.08)}
.btn[disabled]{opacity:.6;cursor:wait}
.err{display:none;background:rgba(255,93,115,.12);border:1px solid rgba(255,93,115,.4);color:var(--bad);border-radius:10px;padding:9px 12px;font-size:14px;font-weight:600}
.err.on{display:block}
.hint{text-align:center;color:var(--muted);font-size:12px}
.logo img{display:block;margin:0 auto;height:46px;width:auto;max-width:100%}
@keyframes shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-7px)}75%{transform:translateX(7px)}}
.shake{animation:shake .25s ease 2}
</style>
</head>
<body>
<form class="card" id="f" autocomplete="off">
  <div class="logo"><img src="/logo.png" alt="Lutrix Game"></div>
  <div class="sub">Закрытая площадка. Введите пароль, чтобы войти.</div>
  <label>Пароль<input id="p" type="password" placeholder="••••••••" autofocus required></label>
  <div class="err" id="err">Неверный пароль. Попробуйте ещё раз.</div>
  <button class="btn" id="b" type="submit">Войти</button>
  <div class="hint">Доступ по паролю. Если вы здесь случайно — уходите.</div>
</form>
<script>
var f=document.getElementById('f'),p=document.getElementById('p'),b=document.getElementById('b'),err=document.getElementById('err');
f.addEventListener('submit',function(e){
  e.preventDefault();
  err.className='err'; b.disabled=true; b.textContent='Проверяем…';
  fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p.value})})
    .then(function(r){
      if(r.ok){ location.replace('/'); return; }
      err.className='err on'; f.classList.remove('shake'); void f.offsetWidth; f.classList.add('shake');
      p.value=''; p.focus();
      if(r.status===429) err.textContent='Слишком много попыток. Подождите 10 минут.';
      b.disabled=false; b.textContent='Войти';
    })
    .catch(function(){ err.textContent='Нет связи с сервером. Обновите страницу.'; err.className='err on'; b.disabled=false; b.textContent='Войти'; });
});
</script>
</body>
</html>`;

function lookup(id) {
  const c = cache.get(id);
  if (c && Date.now() - c.at < DAY) return Promise.resolve(c.url);
  if (inflight.has(id)) return inflight.get(id);
  const name = games.get(id);
  const p = limit(async () => {
    const u = new URL('/api/games', BASE);
    u.searchParams.set('key', KEY);
    u.searchParams.set('search', name);
    u.searchParams.set('page_size', '5');
    u.searchParams.set('search_precise', 'true');
    const r = await fetch(u, { headers: { 'User-Agent': 'LutrixGame/0.1' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('RAWG вернул статус ' + r.status);
    const data = await r.json();
    let best = null, score = 0;
    for (const g of data.results || []) {
      if (!g.background_image) continue;
      const s = similarity(name, g.name);
      if (s > score) { best = g; score = s; }
    }
    let url = best && score >= 0.62 ? best.background_image : null;
    if (url && url.includes('/media/') && !url.includes('/crop/')) url = url.replace('/media/', '/media/crop/600/400/');
    cache.set(id, { url, at: Date.now() });
    return url;
  }).finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400).end('bad request'); return; }

  if (url.pathname === '/healthz') { res.writeHead(200).end('ok'); return; }

  if (url.pathname === '/logo.png') {
    fs.readFile(path.join(PUBLIC, 'logo.png'), (err, buf) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }).end(buf);
    });
    return;
  }

  // ===== вход по паролю =====
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const ip = clientIp(req);
    const JSONH = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
    // сначала лимит, потом проверка: верный пароль тоже не проходит, пока попытки исчерпаны
    if (blocked('gate:' + ip, 10, 10 * MIN) || blocked('gate:*', 60, 10 * MIN)) { res.writeHead(429, JSONH).end('{"error":"too many attempts"}'); return; }
    let body = '';
    try { body = await readBody(req); } catch { res.writeHead(400, JSONH).end('{"error":"bad request"}'); return; }
    let password = '';
    try { password = String(JSON.parse(body).password || ''); } catch { password = ''; }
    const okPass = password.length > 0 && SITE_PASSWORD.length > 0 &&
      password.length === SITE_PASSWORD.length &&
      crypto.timingSafeEqual(Buffer.from(password), Buffer.from(SITE_PASSWORD));
    if (!okPass) {
      bump('gate:' + ip, 10 * MIN); bump('gate:*', 10 * MIN);
      res.writeHead(401, JSONH).end('{"error":"wrong password"}'); return;
    }
    clearBucket('gate:' + ip);
    setSessionCookie(req, res, gateToken(Date.now() + WEEK), WEEK / 1000);
    res.writeHead(200, JSONH).end('{"ok":true}');
    return;
  }

  if (url.pathname === '/api/logout' && req.method === 'POST') {
    setSessionCookie(req, res, '', 0);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end('{"ok":true}');
    return;
  }

  if (url.pathname === '/login') {
    if (isAuthed(req)) { res.writeHead(302, { Location: '/' }).end(); return; }
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(LOGIN_PAGE);
    return;
  }

  // всё остальное — только для вошедших по паролю
  if (!isAuthed(req)) {
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(LOGIN_PAGE);
      return;
    }
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end('{"error":"auth required"}');
    return;
  }

  if (/^\/api\/(market|orders|wallet|me|shop|avatar)(\/|$)/.test(url.pathname)) {
    try { await market.handle(req, res, url, { clientIp, readBody, blocked, bump, clear: clearBucket, totalItems, shop }); }
    catch (e) {
      console.error('market', e.message);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }).end('{"error":"server","message":"Ошибка сервера"}');
    }
    return;
  }

  if (url.pathname.startsWith('/api/auth/')) {
    try { await auth.handle(req, res, url, { clientIp, readBody, blocked, bump, clear: clearBucket }); }
    catch (e) {
      console.error('auth', e.message);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }).end('{"error":"server","message":"Ошибка сервера"}');
    }
    return;
  }

  if (url.pathname === '/api/icon') {
    const id = url.searchParams.get('id') || '';
    if (!/^\d{1,4}$/.test(id) || !apps.has(id)) { res.writeHead(404).end('not found'); return; }
    if (!CLIENT) { res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }).end('BRANDFETCH_CLIENT_ID не задан на сервере'); return; }
    const loc = 'https://cdn.brandfetch.io/' + encodeURIComponent(apps.get(id)) + '/fallback/404?c=' + encodeURIComponent(CLIENT);
    res.writeHead(302, { Location: loc, 'Cache-Control': 'public, max-age=86400' }).end();
    return;
  }

  if (url.pathname === '/api/cover') {
    const id = url.searchParams.get('id') || '';
    if (!/^\d{1,4}$/.test(id) || !games.has(id)) { res.writeHead(404).end('not found'); return; }
    if (!KEY) { res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }).end('RAWG_KEY не задан на сервере'); return; }
    try {
      const img = await lookup(id);
      if (!img) { res.writeHead(404, { 'Cache-Control': 'public, max-age=3600' }).end('no cover'); return; }
      res.writeHead(302, { Location: img, 'Cache-Control': 'public, max-age=86400' }).end();
    } catch (e) {
      console.error('cover', id, e.message);
      res.writeHead(502, { 'Cache-Control': 'no-store' }).end('upstream error');
    }
    return;
  }

  // статика
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end('bad request'); return; }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(404).end('not found'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Страница не найдена'); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' }).end(buf);
  });
});

server.listen(PORT, () => console.log('Lutrix Game запущен на порту ' + PORT + ' (вход по паролю: ' + (process.env.SITE_PASSWORD ? 'переменная окружения SITE_PASSWORD' : 'значение переменной SITE_PASSWORD в server.js') + ')' + ' (владелец: ' + (market.ownerConfigured ? 'OWNER_CODE задан' : 'OWNER_CODE не задан, стать владельцем нельзя') + ') (комиссия пополнения: ' + (market.FEE / 100) + ' ₽) (почта: ' + (auth.mode === 'live' ? (auth.provider === 'brevo' ? 'Brevo' : 'Resend') + ' подключён' : 'не подключена, коды только в журнале') + ') (хранилище: ' + auth.storeNote + ')' + (KEY ? '' : ' (RAWG_KEY не задан: обложек игр не будет)') + (CLIENT ? '' : ' (BRANDFETCH_CLIENT_ID не задан: логотипов приложений не будет)')));
