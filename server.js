'use strict';
// Lootly: статический сайт + прокси обложек RAWG. Ключ живёт только в переменной окружения RAWG_KEY.
const http = require('http');
const fs = require('fs');
const path = require('path');

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
    const r = await fetch(u, { headers: { 'User-Agent': 'Lootly/0.1' }, signal: AbortSignal.timeout(15000) });
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

server.listen(PORT, () => console.log('Lootly запущен на порту ' + PORT + (KEY ? '' : ' (RAWG_KEY не задан: обложек игр не будет)') + (CLIENT ? '' : ' (BRANDFETCH_CLIENT_ID не задан: логотипов приложений не будет)')));
