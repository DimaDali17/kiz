/* ─────────────────────────────────────────────────────────────────────
   pull.mjs — движок сборки. Запускается в GitHub Actions по расписанию.
   Ходит в WB API (токен из GitHub Secrets), собирает заказы в статусах
   sorted / ready_for_pickup / canceled_by_client с КИЗ и ценой и кладёт
   их в Google-таблицу через Apps Script.

   Здесь НЕТ лимита подзапросов Cloudflare — работает на раннере GitHub,
   поэтому подходит и для больших объёмов.

   Требуются переменные окружения (задаются в GitHub → Secrets):
     WB_TOKENS        {"ИП1":"<token1>","ИП2":"<token2>"}
     APPSCRIPT_URL    https://script.google.com/macros/s/..../exec
     APPSCRIPT_TOKEN  тот же TOKEN, что в Script Properties таблицы
   Необязательные:
     DAYS=90          окно поиска заказов (дней назад)
     PRICE_DIVISOR=100  finalPrice в копейках -> руб. (поставь 1, если WB отдаёт рубли)
   Node 20+ (глобальный fetch).
   ───────────────────────────────────────────────────────────────────── */

const WB_BASE = 'https://marketplace-api.wildberries.ru';
const DAYS = parseInt(process.env.DAYS || '90', 10);
const PRICE_DIVISOR = parseInt(process.env.PRICE_DIVISOR || '100', 10);
const TARGET = new Set(['sorted', 'ready_for_pickup', 'canceled_by_client']);

function parseTokens() {
  try {
    const m = JSON.parse(process.env.WB_TOKENS || '{}');
    return Object.keys(m).filter(k => m[k]).map(name => ({ name, token: m[name] }));
  } catch { return []; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const round2 = n => Math.round(n * 100) / 100;

async function wb(token, method, path, body, tries = 4) {
  for (let a = 1; a <= tries; a++) {
    const r = await fetch(WB_BASE + path, {
      method,
      headers: { Authorization: token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 429 || r.status >= 500) { await sleep(Math.min(1500 * a, 6000)); continue; }
    if (!r.ok) throw new Error(`WB ${r.status} ${path}: ${(await r.text()).slice(0, 200)}`);
    return r.status === 204 ? {} : r.json();
  }
  throw new Error(`WB не ответил: ${path}`);
}

async function getOrders(token, dateFrom) {
  const all = []; let next = 0;
  for (let g = 0; g < 200; g++) {
    const j = await wb(token, 'GET', `/api/v3/orders?limit=1000&next=${next}&dateFrom=${dateFrom}`);
    const arr = j.orders || [];
    for (const o of arr) all.push({ id: o.id, createdAt: o.createdAt, article: o.article, nmId: o.nmId, finalPrice: o.finalPrice });
    next = j.next || 0;
    if (arr.length < 1000 || !next) break;
  }
  return all;
}
async function getStatuses(token, ids) {
  const map = new Map();
  for (let i = 0; i < ids.length; i += 1000) {
    const j = await wb(token, 'POST', '/api/v3/orders/status', { orders: ids.slice(i, i + 1000) });
    for (const o of (j.orders || [])) map.set(o.id, o.wbStatus);
  }
  return map;
}
// bulk КИЗ: POST /api/marketplace/v3/orders/meta (батчи по 100), с откатом на per-order
async function getMeta(token, ids) {
  const out = new Map(); if (!ids.length) return out;
  let bulkOk = true, firstRaw = null;
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    let j;
    try { j = await wb(token, 'POST', '/api/marketplace/v3/orders/meta', { orders: chunk }); }
    catch { bulkOk = false; break; }
    if (i === 0) firstRaw = j;
    const arr = j.orders || j.meta || (Array.isArray(j) ? j : []);
    for (const it of arr) out.set(it.orderId ?? it.id ?? it.order, extractSgtin(it));
  }
  if (firstRaw) console.log('DEBUG первый ответ bulk-meta:', JSON.stringify(firstRaw).slice(0, 600));
  if (bulkOk) return out;
  console.log('bulk-meta недоступен, откатываюсь на per-order');
  for (const id of ids) {
    try { const j = await wb(token, 'GET', `/api/v3/orders/${id}/meta`); out.set(id, (j.meta && j.meta.sgtin) || []); }
    catch { out.set(id, []); }
  }
  return out;
}
function extractSgtin(it) {
  const raw = it.sgtin ?? it.sgtins ?? (it.meta && it.meta.sgtin) ?? [];
  const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  return arr.map(x => (typeof x === 'string' ? x : (x.code || x.sgtin || x.value || ''))).filter(Boolean);
}

async function collect(t, dateFrom) {
  const orders = await getOrders(t.token, dateFrom);
  const byId = new Map(orders.map(o => [o.id, o]));
  const statusById = await getStatuses(t.token, [...byId.keys()]);
  const targetIds = [...statusById.entries()].filter(([, s]) => TARGET.has(s)).map(([id]) => id);
  console.log(`  ${t.name}: заказов ${orders.length}, целевых ${targetIds.length}`);
  const kizById = await getMeta(t.token, targetIds);
  const rows = [];
  for (const id of targetIds) {
    const o = byId.get(id) || {};
    const price = round2((o.finalPrice || 0) / PRICE_DIVISOR);
    const base = { date: (o.createdAt || '').slice(0, 10), id, co: t.name, status: statusById.get(id), article: o.article || '' };
    const kizes = kizById.get(id) || [];
    if (!kizes.length) rows.push({ ...base, kiz: '', price });
    else for (const k of kizes) rows.push({ ...base, kiz: String(k).slice(0, 31), price });
  }
  return rows;
}

async function main() {
  const tokens = parseTokens();
  if (!tokens.length) throw new Error('WB_TOKENS пуст или неверен');
  if (!process.env.APPSCRIPT_URL || !process.env.APPSCRIPT_TOKEN) throw new Error('APPSCRIPT_URL / APPSCRIPT_TOKEN не заданы');

  const dateFrom = Math.floor(Date.now() / 1000) - DAYS * 86400;
  let rows = [];
  for (const t of tokens) rows = rows.concat(await collect(t, dateFrom));
  console.log(`Итого строк: ${rows.length}`);

  const res = await fetch(process.env.APPSCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: process.env.APPSCRIPT_TOKEN, action: 'setOrders', rows, builtAt: new Date().toISOString(), window: DAYS }),
    redirect: 'follow',
  });
  const txt = await res.text();
  console.log('Ответ Apps Script:', txt.slice(0, 300));
  if (!res.ok) throw new Error('Apps Script HTTP ' + res.status);
}

main().catch(e => { console.error('ОШИБКА:', e.message); process.exit(1); });
