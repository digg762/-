'use strict';
// Lutrix Game: кошелёк, объявления, заказы, аватары, магазин игр.
// Все суммы на сервере хранятся в копейках (целые числа), чтобы не копились ошибки округления.
//
// Деньги за заказ маркетплейса удерживаются на платформе и уходят продавцу, когда
// покупатель подтверждает получение (или через 72 часа после выдачи, если он молчит).
const crypto = require('crypto');
const auth = require('./auth');
const A = auth.core;
const { mem, store } = A;

const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const FEE = Math.max(0, Math.round((parseFloat(String(process.env.TOPUP_FEE || '1').replace(',', '.')) || 0) * 100)); // комиссия с пополнения, копеек
const TOPUP_MIN = 10 * 100, TOPUP_MAX = 100000 * 100;
const OWNER_CODE = (process.env.OWNER_CODE || '').trim();
const CATS = ['cur', 'acc', 'item', 'key', 'boost', 'sub', 'dlc', 'prop'];
const AUTO_CONFIRM = 72 * HOUR;
const MAX_ACTIVE_OFFERS = 60;
const MAX_AVATAR_BYTES = 60 * 1024;

/* ===== общие помощники ===== */
const rid = () => crypto.randomBytes(6).toString('hex');
const clean = (v, max, keepNl) => String(v == null ? '' : v)
  .replace(keepNl ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, '')
  .trim().slice(0, max);
function send(res, status, obj, extra) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extra || {})).end(JSON.stringify(obj));
}
const fail = (res, status, error, message, extra) => send(res, status, Object.assign({ error, message }, extra || {}));
async function readJson(req, ctx, limit) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return { bad: 415 };
  try { return { body: JSON.parse(await ctx.readBody(req, limit || 20000)) || {} }; } catch { return { bad: 400 }; }
}
// записать в базу; если база не отвечает, данные остаются в памяти и дописываются сами
async function commit() {
  try { await store.flush(); } catch (e) { if (!e.dbError) throw e; }
}
const dbDown = res => fail(res, 503, 'db_down', 'База данных временно недоступна. Попробуйте через минуту.');

/* ===== журнал операций и баланс ===== */
const byUserLedger = new Map(); // uid -> [записи], новые в конце
let indexed = false;
function indexLedger() {
  if (indexed) return; indexed = true;
  const all = [...mem.ledger.values()].sort((a, b) => a.at - b.at);
  for (const e of all) { if (!byUserLedger.has(e.uid)) byUserLedger.set(e.uid, []); byUserLedger.get(e.uid).push(e); }
}
function addLedger(u, type, amt, note, ref) {
  indexLedger();
  const e = { id: rid() + rid(), uid: u.id, type, amt, bal: u.bal, note: note || '', ref: ref || '', at: Date.now() };
  mem.ledger.set(e.id, e);
  if (!byUserLedger.has(u.id)) byUserLedger.set(u.id, []);
  byUserLedger.get(u.id).push(e);
  store.mark.doc('ledger', e.id);
}
// изменить баланс и записать операцию (всё синхронно, поэтому без гонок)
function move(u, amt, type, note, ref) {
  u.bal = (u.bal || 0) + amt;
  addLedger(u, type, amt, note, ref);
  store.mark.user(u.id);
}
const rub = kop => (kop / 100).toLocaleString('ru-RU', { minimumFractionDigits: kop % 100 ? 2 : 0, maximumFractionDigits: 2 }) + ' ₽';

function platform() {
  let p = mem.meta.get('platform');
  if (!p) { p = { id: 'platform', pending: 0, feesTotal: 0, shopTotal: 0 }; mem.meta.set('platform', p); }
  return p;
}
// счёт владельца: самый давний из тех, кто ввёл промокод владельца
function treasury() {
  let t = null;
  for (const u of Object.values(mem.users)) if (u.owner && u.verified && (!t || (u.ownerAt || 0) < (t.ownerAt || 0))) t = u;
  return t;
}
// доход платформы (комиссии, продажи магазина): владельцу или, пока владельца нет, в копилку
function platformIncome(amt, type, note, ref) {
  const p = platform();
  if (type === 'fee') p.feesTotal += amt; else p.shopTotal += amt;
  store.mark.doc('meta', 'platform');
  const t = treasury();
  if (t) move(t, amt, type, note, ref); else p.pending += amt;
}

/* ===== объявления ===== */
const offersCache = { n: -1, ver: 0, data: null };
const touchOffers = () => { offersCache.ver++; };
const liveOffer = o => o.status === 'active' && o.stock > 0;
function sellerView(uid) {
  if (!uid) return { id: '', name: 'Lutrix Game', av: 0, deals: 0, owner: true };
  const s = mem.users[uid];
  return s ? { id: s.id, name: s.name, av: s.avv || 0, deals: s.sales || 0, owner: !!s.owner } : { id: uid, name: 'Удалён', av: 0, deals: 0 };
}
function offerPublic(o) {
  return { id: o.id, gid: o.gid, cat: o.cat, title: o.title, desc: o.desc, price: o.price, attrs: o.attrs, delivery: o.delivery, stock: o.stock, sold: o.sold, createdAt: o.createdAt, seller: sellerView(o.uid) };
}
function offerMine(o) {
  return Object.assign(offerPublic(o), { status: o.status, auto: o.delivery === 'Автовыдача' });
}
function summary() {
  if (offersCache.data && offersCache.n === offersCache.ver) return offersCache.data;
  const items = {};
  for (const o of mem.offers.values()) {
    if (!liveOffer(o)) continue;
    const it = items[o.gid] || (items[o.gid] = { n: {}, min: 0 });
    it.n[o.cat] = (it.n[o.cat] || 0) + 1;
    if (!it.min || o.price < it.min) it.min = o.price;
  }
  offersCache.data = { items }; offersCache.n = offersCache.ver;
  return offersCache.data;
}
function cleanAttrs(a) {
  const out = {};
  if (!a || typeof a !== 'object' || Array.isArray(a)) return out;
  for (const [k, v] of Object.entries(a).slice(0, 14)) {
    if (!/^[a-z]{2,16}$/.test(k)) continue;
    if (v === true) out[k] = true;
    else if (typeof v === 'string' && v.trim()) out[k] = clean(v, 40);
  }
  return out;
}
const parsePrice = v => { const n = Math.round(parseFloat(String(v).replace(',', '.')) * 100); return Number.isFinite(n) ? n : NaN; };
const splitItems = text => String(text || '').split('\n').map(l => clean(l, 500)).filter(Boolean);

/* ===== заказы ===== */
function orderBuyerView(o) {
  const v = { id: o.id, kind: o.kind, title: o.title, gid: o.gid, cat: o.cat, price: o.price, status: o.status, delivery: o.delivery, createdAt: o.createdAt, deliveredAt: o.deliveredAt || 0, completedAt: o.completedAt || 0, seller: sellerView(o.seller) };
  if (o.secret) v.secret = o.secret;
  if (o.msg) v.msg = o.msg;
  if (o.note) v.note = o.note;
  return v;
}
function orderSellerView(o) {
  const b = mem.users[o.buyer];
  return { id: o.id, kind: o.kind, title: o.title, gid: o.gid, cat: o.cat, price: o.price, status: o.status, delivery: o.delivery, createdAt: o.createdAt, deliveredAt: o.deliveredAt || 0, completedAt: o.completedAt || 0, buyer: b ? { id: b.id, name: b.name, av: b.avv || 0 } : { id: o.buyer, name: 'Удалён', av: 0 }, msg: o.msg || '' };
}
function completeOrder(o, why) {
  const seller = mem.users[o.seller];
  o.status = 'completed'; o.completedAt = Date.now();
  if (seller) { move(seller, o.price, 'sale', 'Продажа: ' + o.title.slice(0, 60) + (why ? ' (' + why + ')' : ''), o.id); seller.sales = (seller.sales || 0) + 1; }
  else platformIncome(o.price, 'shop', 'Продавец удалён: ' + o.title.slice(0, 60), o.id);
  store.mark.doc('orders', o.id);
}
// 72 часа тишины после выдачи: деньги уходят продавцу
setInterval(() => {
  if (!A.isReady() || !store.healthy()) return;
  const now = Date.now(); let n = 0;
  for (const o of mem.orders.values()) if (o.status === 'delivered' && o.kind === 'market' && now - o.deliveredAt > AUTO_CONFIRM) { completeOrder(o, 'автоподтверждение'); n++; }
  if (n) store.flush().catch(() => {});
}, 10 * MIN).unref();

/* ===== аватары ===== */
function parseAvatar(data) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(data || ''));
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length < 100 || buf.length > MAX_AVATAR_BYTES) return null;
  const ok = m[1] === 'image/jpeg' ? buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
    : m[1] === 'image/png' ? buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP';
  return ok ? { mime: m[1], buf } : null;
}

/* ===== запросы ===== */
async function handle(req, res, url, ctx) {
  try { return await route(req, res, url, ctx); }
  catch (e) {
    if (e && e.dbError && !res.headersSent) return dbDown(res);
    throw e;
  }
}

async function route(req, res, url, ctx) {
  const p = url.pathname, post = req.method === 'POST', get = req.method === 'GET';
  if (!A.isReady()) return fail(res, 503, 'db_down', 'Сервис запускается, попробуйте через несколько секунд.');

  /* --- аватар (виден всем, кто прошёл пароль сайта) --- */
  if (p === '/api/avatar' && get) {
    const u = mem.users[String(url.searchParams.get('u') || '')];
    const a = u && u.avatar && parseAvatar(u.avatar);
    if (!a) { res.writeHead(404).end('no avatar'); return; }
    res.writeHead(200, { 'Content-Type': a.mime, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" }).end(a.buf);
    return;
  }

  /* --- публичный каталог --- */
  if (p === '/api/market/summary' && get) return send(res, 200, summary());
  if (p === '/api/market/offers' && get) {
    const gid = Number(url.searchParams.get('gid')), cat = String(url.searchParams.get('cat') || '');
    if (!Number.isInteger(gid) || gid < 0 || gid >= ctx.totalItems || !CATS.includes(cat)) return fail(res, 400, 'bad_request', 'Некорректный запрос');
    const list = [...mem.offers.values()].filter(o => o.gid === gid && o.cat === cat && liveOffer(o)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 300).map(offerPublic);
    return send(res, 200, { offers: list });
  }

  /* --- дальше только для вошедших в аккаунт --- */
  const u = A.userFromReq(req);
  if (!u) return fail(res, 401, 'login_required', 'Войдите в аккаунт.');

  if (p === '/api/me/wallet' && get) {
    indexLedger();
    const out = { balance: u.bal || 0, owner: !!u.owner, fee: FEE, ledger: (byUserLedger.get(u.id) || []).slice(-60).reverse().map(e => ({ id: e.id, type: e.type, amt: e.amt, bal: e.bal, note: e.note, at: e.at })) };
    if (u.owner) {
      const pl = platform();
      out.stats = { users: Object.keys(mem.users).length, offers: mem.offers.size, orders: mem.orders.size, feesTotal: pl.feesTotal, shopTotal: pl.shopTotal, pending: pl.pending, isTreasury: (treasury() || {}).id === u.id };
    }
    return send(res, 200, out);
  }
  if (p === '/api/me/offers' && get) {
    const list = [...mem.offers.values()].filter(o => o.uid === u.id).sort((a, b) => b.createdAt - a.createdAt).map(offerMine);
    return send(res, 200, { offers: list });
  }
  if (p === '/api/me/orders' && get) {
    const all = [...mem.orders.values()].sort((a, b) => b.createdAt - a.createdAt);
    return send(res, 200, {
      buys: all.filter(o => o.buyer === u.id).slice(0, 100).map(orderBuyerView),
      sales: all.filter(o => o.seller === u.id && o.kind === 'market').slice(0, 100).map(orderSellerView)
    });
  }

  if (!post) return fail(res, 404, 'not_found', 'Не найдено');
  const parsed = await readJson(req, ctx, p === '/api/me/avatar' ? 120000 : 20000);
  if (parsed.bad) return fail(res, parsed.bad, 'bad_request', 'Некорректный запрос');
  const b = parsed.body;

  /* --- аватар --- */
  if (p === '/api/me/avatar') {
    if (ctx.blocked('av:' + u.id, 20, HOUR)) return fail(res, 429, 'too_many', 'Слишком часто. Попробуйте позже.');
    ctx.bump('av:' + u.id, HOUR);
    if (b.image === null) { delete u.avatar; u.avv = (u.avv || 0) + 1; }
    else {
      if (!parseAvatar(b.image)) return fail(res, 400, 'bad_image', 'Картинка не подошла: нужен JPEG, PNG или WebP до 60 КБ.');
      u.avatar = b.image; u.avv = (u.avv || 0) + 1;
    }
    store.mark.user(u.id); await store.flush();
    return send(res, 200, { ok: true, user: A.pub(u) });
  }

  /* --- пополнение баланса (демо: настоящих денег нет) --- */
  if (p === '/api/wallet/topup') {
    if (!store.healthy()) return dbDown(res);
    if (ctx.blocked('tu:' + u.id, 30, HOUR)) return fail(res, 429, 'too_many', 'Слишком много пополнений за час. Попробуйте позже.');
    const kop = parsePrice(b.amount);
    if (!Number.isFinite(kop) || kop < TOPUP_MIN) return fail(res, 400, 'bad_amount', 'Минимальная сумма пополнения: 10 ₽.');
    if (kop > TOPUP_MAX) return fail(res, 400, 'bad_amount', 'Максимальная сумма за раз: 100 000 ₽.');
    ctx.bump('tu:' + u.id, HOUR);
    const fee = Math.min(FEE, kop - 1);
    move(u, kop - fee, 'topup', `Пополнение ${rub(kop)}` + (fee ? `, комиссия ${rub(fee)}` : '') + ' (демо)');
    if (fee) platformIncome(fee, 'fee', `Комиссия с пополнения ${rub(kop)}, ${u.name}`, u.id);
    await commit();
    return send(res, 200, { ok: true, balance: u.bal, credited: kop - fee, fee, user: A.pub(u) });
  }

  /* --- промокод (код владельца задаётся переменной OWNER_CODE) --- */
  if (p === '/api/wallet/promo') {
    const key = 'promo:' + ctx.clientIp(req);
    if (ctx.blocked(key, 5, 10 * MIN) || ctx.blocked('promo:' + u.id, 8, 10 * MIN)) return fail(res, 429, 'too_many', 'Слишком много попыток. Подождите 10 минут.');
    const code = clean(b.code, 100);
    const hash = s => crypto.createHash('sha256').update(s).digest();
    const okCode = OWNER_CODE.length > 0 && crypto.timingSafeEqual(hash(code), hash(OWNER_CODE));
    if (!okCode) { ctx.bump(key, 10 * MIN); ctx.bump('promo:' + u.id, 10 * MIN); return fail(res, 404, 'bad_promo', 'Такого промокода нет.'); }
    if (u.owner) return send(res, 200, { ok: true, already: true, message: 'Вы уже владелец.', user: A.pub(u) });
    if (!store.healthy()) return dbDown(res);
    u.owner = true; u.ownerAt = Date.now(); store.mark.user(u.id);
    const pl = platform();
    if (pl.pending > 0 && (treasury() || {}).id === u.id) { const amt = pl.pending; pl.pending = 0; store.mark.doc('meta', 'platform'); move(u, amt, 'fee', 'Накопленные доходы платформы до появления владельца'); }
    await commit();
    return send(res, 200, { ok: true, message: 'Готово: теперь вы владелец. Комиссии с пополнений будут приходить на ваш баланс.', user: A.pub(u) });
  }
  if (p === '/api/me/owner-off') {
    if (!u.owner) return send(res, 200, { ok: true, user: A.pub(u) });
    u.owner = false; delete u.ownerAt; store.mark.user(u.id); await commit();
    return send(res, 200, { ok: true, user: A.pub(u) });
  }

  /* --- объявления --- */
  if (p === '/api/market/offers') {
    if (!store.healthy()) return dbDown(res);
    if (ctx.blocked('mk:' + u.id, 30, HOUR)) return fail(res, 429, 'too_many', 'Слишком много объявлений за час. Попробуйте позже.');
    const gid = Number(b.gid), cat = String(b.cat || '');
    if (!Number.isInteger(gid) || gid < 0 || gid >= ctx.totalItems) return fail(res, 400, 'bad_game', 'Выберите игру или приложение.');
    if (!CATS.includes(cat)) return fail(res, 400, 'bad_cat', 'Выберите раздел.');
    const title = clean(b.title, 120);
    if (title.length < 5) return fail(res, 400, 'bad_title', 'Название: от 5 символов.');
    const desc = clean(b.desc, 1000, true);
    const price = parsePrice(b.price);
    if (!Number.isFinite(price) || price < 100 || price > 1000000 * 100) return fail(res, 400, 'bad_price', 'Цена: от 1 ₽ до 1 000 000 ₽.');
    const delivery = b.delivery === 'Автовыдача' ? 'Автовыдача' : 'Вручную';
    let stock, items = [];
    if (delivery === 'Автовыдача') {
      items = splitItems(b.items);
      if (!items.length) return fail(res, 400, 'bad_items', 'Для автовыдачи впишите данные для покупателя: одна позиция на строку.');
      if (items.length > 200) return fail(res, 400, 'bad_items', 'Не больше 200 позиций за раз.');
      stock = items.length;
    } else {
      stock = Math.floor(Number(b.stock));
      if (!Number.isInteger(stock) || stock < 1 || stock > 9999) return fail(res, 400, 'bad_stock', 'Количество: от 1 до 9999.');
    }
    if ([...mem.offers.values()].filter(o => o.uid === u.id).length >= MAX_ACTIVE_OFFERS) return fail(res, 400, 'too_many_offers', 'У вас уже ' + MAX_ACTIVE_OFFERS + ' объявлений. Удалите ненужные.');
    ctx.bump('mk:' + u.id, HOUR);
    const attrs = cleanAttrs(b.attrs); attrs.delivery = delivery;
    const o = { id: rid(), uid: u.id, gid, cat, title, desc, price, attrs, delivery, stock, items, sold: 0, status: 'active', createdAt: Date.now() };
    mem.offers.set(o.id, o); store.mark.doc('offers', o.id); touchOffers();
    await commit();
    return send(res, 200, { ok: true, offer: offerMine(o) });
  }
  if (p === '/api/market/offers/edit' || p === '/api/market/offers/status') {
    if (!store.healthy()) return dbDown(res);
    const o = mem.offers.get(String(b.id || ''));
    if (!o || (o.uid !== u.id && !u.owner)) return fail(res, 404, 'not_found', 'Объявление не найдено.');
    if (p.endsWith('/status')) {
      if (b.status === 'deleted') { mem.offers.delete(o.id); }
      else if (b.status === 'active' || b.status === 'paused') o.status = b.status;
      else return fail(res, 400, 'bad_request', 'Некорректный запрос');
    } else {
      if (b.price !== undefined) { const pr = parsePrice(b.price); if (!Number.isFinite(pr) || pr < 100 || pr > 1000000 * 100) return fail(res, 400, 'bad_price', 'Цена: от 1 ₽ до 1 000 000 ₽.'); o.price = pr; }
      if (b.title !== undefined) { const t = clean(b.title, 120); if (t.length < 5) return fail(res, 400, 'bad_title', 'Название: от 5 символов.'); o.title = t; }
      if (b.desc !== undefined) o.desc = clean(b.desc, 1000, true);
      if (o.delivery === 'Автовыдача' && b.addItems) {
        const add = splitItems(b.addItems); if (o.items.length + add.length > 500) return fail(res, 400, 'bad_items', 'В объявлении не больше 500 позиций.');
        o.items.push(...add); o.stock = o.items.length;
      } else if (o.delivery !== 'Автовыдача' && b.stock !== undefined) {
        const st = Math.floor(Number(b.stock)); if (!Number.isInteger(st) || st < 0 || st > 9999) return fail(res, 400, 'bad_stock', 'Количество: от 0 до 9999.'); o.stock = st;
      }
    }
    store.mark.doc('offers', o.id); touchOffers();
    await commit();
    return send(res, 200, { ok: true });
  }

  /* --- покупка и заказы --- */
  if (p === '/api/orders/buy') {
    if (!store.healthy()) return dbDown(res);
    if (ctx.blocked('buy:' + u.id, 40, HOUR)) return fail(res, 429, 'too_many', 'Слишком много покупок за час.');
    const o = mem.offers.get(String(b.offerId || ''));
    if (!o || !liveOffer(o)) return fail(res, 404, 'gone', 'Это предложение уже недоступно.');
    if (o.uid === u.id) return fail(res, 400, 'own', 'Нельзя купить своё объявление.');
    if ((u.bal || 0) < o.price) return fail(res, 402, 'no_funds', 'Не хватает денег на балансе.', { need: o.price - (u.bal || 0) });
    ctx.bump('buy:' + u.id, HOUR);
    // дальше всё без пауз: проверка и списание в одном шаге
    const ord = { id: rid(), kind: 'market', buyer: u.id, seller: o.uid, offerId: o.id, gid: o.gid, cat: o.cat, title: o.title, price: o.price, delivery: o.delivery, status: 'paid', createdAt: Date.now() };
    move(u, -o.price, 'buy', 'Покупка: ' + o.title.slice(0, 60), ord.id);
    o.sold += 1;
    if (o.delivery === 'Автовыдача') { ord.secret = o.items.shift(); o.stock = o.items.length; ord.status = 'delivered'; ord.deliveredAt = Date.now(); }
    else o.stock -= 1;
    mem.orders.set(ord.id, ord);
    store.mark.doc('orders', ord.id); store.mark.doc('offers', o.id); touchOffers();
    await commit();
    return send(res, 200, { ok: true, order: orderBuyerView(ord), balance: u.bal });
  }
  if (p === '/api/orders/deliver') {
    if (!store.healthy()) return dbDown(res);
    const o = mem.orders.get(String(b.id || ''));
    if (!o || o.seller !== u.id || o.kind !== 'market') return fail(res, 404, 'not_found', 'Заказ не найден.');
    const msg = clean(b.message, 1000, true);
    if (o.status !== 'paid') return fail(res, 400, 'state', 'Этот заказ уже нельзя выдать.');
    if (!msg) return fail(res, 400, 'bad_message', 'Напишите покупателю данные или инструкцию.');
    o.msg = msg; o.status = 'delivered'; o.deliveredAt = Date.now();
    store.mark.doc('orders', o.id); await commit();
    return send(res, 200, { ok: true });
  }
  if (p === '/api/orders/confirm') {
    if (!store.healthy()) return dbDown(res);
    const o = mem.orders.get(String(b.id || ''));
    if (!o || o.buyer !== u.id || o.kind !== 'market') return fail(res, 404, 'not_found', 'Заказ не найден.');
    if (o.status !== 'delivered') return fail(res, 400, 'state', 'Подтвердить можно после выдачи.');
    completeOrder(o); await commit();
    return send(res, 200, { ok: true });
  }
  if (p === '/api/orders/cancel') {
    if (!store.healthy()) return dbDown(res);
    const o = mem.orders.get(String(b.id || ''));
    if (!o || o.kind !== 'market' || (o.seller !== u.id && o.buyer !== u.id)) return fail(res, 404, 'not_found', 'Заказ не найден.');
    if (o.status !== 'paid') return fail(res, 400, 'state', 'Отменить можно только заказ, который ещё не выдан.');
    const buyer = mem.users[o.buyer];
    o.status = 'canceled'; o.completedAt = Date.now();
    if (buyer) move(buyer, o.price, 'refund', 'Возврат: ' + o.title.slice(0, 60), o.id);
    const off = mem.offers.get(o.offerId);
    if (off && off.delivery !== 'Автовыдача') { off.stock += 1; off.sold = Math.max(0, off.sold - 1); store.mark.doc('offers', off.id); touchOffers(); }
    store.mark.doc('orders', o.id); await commit();
    return send(res, 200, { ok: true });
  }

  /* --- магазин игр (продаёт сама площадка, деньги идут владельцу) --- */
  if (p === '/api/shop/checkout') {
    if (!store.healthy()) return dbDown(res);
    const ids = Array.isArray(b.ids) ? [...new Set(b.ids.map(Number))].filter(i => Number.isInteger(i) && ctx.shop[i]).slice(0, 30) : [];
    if (!ids.length) return fail(res, 400, 'empty', 'Корзина пуста.');
    const total = ids.reduce((s, i) => s + ctx.shop[i].price, 0);
    if ((u.bal || 0) < total) return fail(res, 402, 'no_funds', 'Не хватает денег на балансе.', { need: total - (u.bal || 0) });
    const made = [];
    for (const i of ids) {
      const it = ctx.shop[i];
      const ord = { id: rid(), kind: 'shop', buyer: u.id, seller: '', gid: -1, cat: 'key', title: it.name, price: it.price, delivery: 'Ключ', status: 'completed', createdAt: Date.now(), completedAt: Date.now(), note: 'Демо: ключ не выдаётся, настоящих игр нет.' };
      move(u, -it.price, 'shop', 'Магазин игр: ' + it.name, ord.id);
      platformIncome(it.price, 'shop', 'Продажа в магазине игр: ' + it.name, ord.id);
      mem.orders.set(ord.id, ord); store.mark.doc('orders', ord.id); made.push(orderBuyerView(ord));
    }
    await commit();
    return send(res, 200, { ok: true, orders: made, balance: u.bal });
  }

  return fail(res, 404, 'not_found', 'Не найдено');
}

module.exports = { handle, FEE, ownerConfigured: !!OWNER_CODE };
