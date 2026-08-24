/* ─────────────────────────────────────────────────────────────────────
   pull.mjs — движок сборки для GitHub Actions.
   Берёт заказы FBS из АРХИВА (там лежат отгруженные/отменённые) и из
   активного списка, определяет статус, подтягивает КИЗ и кладёт в
   Google-таблицу через Apps Script. Реестр «Выгружено» не трогает.

   Источники WB:
     GET /api/marketplace/v3/fbs/orders/archive   — архив (основной источник)
     GET /api/v3/orders (окнами по 30 дней)        — активные (waiting/sorted/…)
     POST /api/v3/orders/status                    — актуальный wbStatus
     POST /api/marketplace/v3/orders/meta          — КИЗ (sgtin), батчи по 100

   Нужны переменные окружения (GitHub → Secrets):
     WB_TOKENS        {"ИП1":"<token1>","ИП2":"<token2>"}
     APPSCRIPT_URL    https://script.google.com/macros/s/..../exec
     APPSCRIPT_TOKEN  тот же TOKEN, что в свойствах скрипта таблицы
   Необязательные:
     DAYS=90            окно (дней назад)
     PRICE_DIVISOR=100  копейки -> рубли (в данных WB копейки, делитель 100 верный)
   Node 20+.
   ───────────────────────────────────────────────────────────────────── */

const WB_BASE = 'https://marketplace-api.wildberries.ru';
const DAYS = parseInt(process.env.DAYS || '90', 10);
const PRICE_DIVISOR = parseInt(process.env.PRICE_DIVISOR || '100', 10);
// показываем все статусы; действия в дашборде: вывод = sold, возврат = canceled_by_client
const OUT_ST = new Set(['sorted', 'ready_for_pickup']);
const RET_ST = new Set(['canceled_by_client']);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const round2 = n => Math.round(n * 100) / 100;

function parseTokens() {
  try {
    const m = JSON.parse(process.env.WB_TOKENS || '{}');
    return Object.keys(m).filter(k => m[k]).map(name => ({ name, token: m[name] }));
  } catch { return []; }
}

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

// нормализуем один объект заказа в наши поля (лишнее игнорируем)
function mapOrder(o) {
  return {
    id: o.id,
    createdAt: o.createdAt || '',
    article: o.article || '',
    nmId: o.nmId || '',
    // convertedPrice = цена в валюте продавца (рубли). price = валюта покупателя (даёт аномалии по СНГ)
    price: (o.convertedPrice != null ? o.convertedPrice : (o.finalPrice != null ? o.finalPrice : (o.price != null ? o.price : 0))),
    supplyId: o.supplyId || '',                    // WB-GI-... для сверки с кабинетом
    wbStatus: o.wbStatus || o.status || '',
    sgtin: extractSgtin(o),
  };
}
function extractSgtin(it) {
  let raw = null;
  if (it && it.meta && it.meta.sgtin != null)
    raw = (it.meta.sgtin && it.meta.sgtin.value != null) ? it.meta.sgtin.value : it.meta.sgtin;
  else if (it && it.sgtin != null) raw = it.sgtin;
  else if (it && it.sgtins != null) raw = it.sgtins;
  const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  return arr.map(x => (typeof x === 'string' ? x : (x && (x.code || x.sgtin || x.value)) || '')).filter(Boolean);
}

// АКТИВНЫЕ: окнами по 30 дней (лимит метода)
async function getActive(token) {
  const out = []; const now = Math.floor(Date.now() / 1000); const step = 30 * 86400;
  for (let from = now - DAYS * 86400; from < now; from += step) {
    const to = Math.min(from + step, now);
    let next = 0;
    for (let g = 0; g < 100; g++) {
      let j;
      try { j = await wb(token, 'GET', `/api/v3/orders?limit=1000&next=${next}&dateFrom=${from}&dateTo=${to}`); }
      catch (e) { console.log('  активные: ошибка', e.message); break; }
      const arr = j.orders || [];
      for (const o of arr) out.push(mapOrder(o));
      next = j.next || 0;
      if (arr.length < 1000 || !next) break;
    }
  }
  return out;
}

// ПОСТАВКИ: supplyId -> дата создания поставки (для сверки с кабинетом)
async function getSupplies(token) {
  const map = new Map(); let next = 0;
  for (let g = 0; g < 100; g++) {
    let j;
    try { j = await wb(token, 'GET', `/api/v3/supplies?limit=1000&next=${next}`); }
    catch (e) { console.log('  поставки: ошибка', e.message); break; }
    const arr = j.supplies || [];
    for (const sup of arr) map.set(sup.id, sup.createdAt || sup.closedAt || '');
    next = j.next || 0;
    if (arr.length < 1000 || !next) break;
  }
  return map;
}

async function getStatuses(token, ids) {
  const map = new Map();
  for (let i = 0; i < ids.length; i += 1000) {
    try {
      const j = await wb(token, 'POST', '/api/v3/orders/status', { orders: ids.slice(i, i + 1000) });
      for (const o of (j.orders || [])) map.set(o.id, o.wbStatus);
    } catch (e) { console.log('  статусы: ошибка чанка', e.message); }
  }
  return map;
}

async function getMeta(token, ids) {
  const out = new Map(); if (!ids.length) return out;
  let bulkOk = true, firstRaw = null;
  for (let i = 0; i < ids.length; i += 100) {
    let j;
    try { j = await wb(token, 'POST', '/api/marketplace/v3/orders/meta', { orders: ids.slice(i, i + 100) }); }
    catch { bulkOk = false; break; }
    if (i === 0) firstRaw = j;
    const arr = j.orders || j.meta || (Array.isArray(j) ? j : []);
    for (const it of arr) out.set(it.orderId ?? it.id ?? it.order, extractSgtin(it));
  }
  if (firstRaw) console.log('  DEBUG bulk-meta, первый ответ:', JSON.stringify(firstRaw).slice(0, 400));
  if (bulkOk) return out;
  console.log('  bulk-meta недоступен, откат на per-order');
  for (const id of ids) {
    try { const j = await wb(token, 'GET', `/api/v3/orders/${id}/meta`); out.set(id, (j.meta && j.meta.sgtin) || []); }
    catch { out.set(id, []); }
  }
  return out;
}

async function collect(t) {
  console.log(`ИП ${t.name}:`);
  const act = await getActive(t.token);
  const supplyMap = await getSupplies(t.token);
  console.log(`  заказов: ${act.length}, поставок: ${supplyMap.size}`);

  const byId = new Map();
  for (const o of act) if (!byId.has(o.id)) byId.set(o.id, o);
  const ids = [...byId.keys()];

  // актуальный статус (авторитетно) — для тех, у кого нет инлайн-статуса
  const statusById = await getStatuses(t.token, ids);
  for (const id of ids) {
    const s = statusById.get(id);
    if (s) byId.get(id).wbStatus = s;
  }

  // берём ВСЕ заказы с известным статусом (фильтрация — в дашборде)
  const keepIds = ids.filter(id => byId.get(id).wbStatus);
  const outN = keepIds.filter(id => OUT_ST.has(byId.get(id).wbStatus)).length;
  const retN = keepIds.filter(id => RET_ST.has(byId.get(id).wbStatus)).length;
  console.log(`  всего: ${keepIds.length} · вывод(sorted/ready): ${outN} · возврат(canceled_by_client): ${retN}`);

  // КИЗ для всех, у кого его ещё нет инлайн
  const needKiz = keepIds.filter(id => !byId.get(id).sgtin.length);
  const kizById = await getMeta(t.token, needKiz);
  for (const [id, arr] of kizById) if (byId.get(id)) byId.get(id).sgtin = arr;

  // строки
  const rows = [];
  let noKiz = 0;
  for (const id of keepIds) {
    const o = byId.get(id);
    const price = round2((o.price || 0) / PRICE_DIVISOR);
    const base = { date: (o.createdAt || '').slice(0, 10), id, co: t.name, status: o.wbStatus, article: o.article, supplyId: o.supplyId || '', supplyDate: (supplyMap.get(o.supplyId) || '').slice(0, 10) };
    if (!o.sgtin.length) { rows.push({ ...base, kiz: '', price }); noKiz++; }
    else for (const k of o.sgtin) rows.push({ ...base, kiz: String(k).slice(0, 31), price });
  }
  console.log(`  строк: ${rows.length}, без КИЗ: ${noKiz}`);
  return rows;
}

async function main() {
  const tokens = parseTokens();
  if (!tokens.length) throw new Error('WB_TOKENS пуст или неверен');
  if (!process.env.APPSCRIPT_URL || !process.env.APPSCRIPT_TOKEN) throw new Error('APPSCRIPT_URL / APPSCRIPT_TOKEN не заданы');

  let rows = [];
  for (const t of tokens) rows = rows.concat(await collect(t));
  console.log(`ИТОГО строк: ${rows.length}`);

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
