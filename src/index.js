// src/index.js
// Stock Alerts Daemon — Finnhub WS → Webhook n8n → (Telegram en n8n)
// Modo SIM opcional para pruebas fuera de horario/fin de semana.

import 'dotenv/config';
import WebSocket from 'ws';
import fetch from 'node-fetch';

// --------- Configuración (env) ----------
const {
  FINNHUB_TOKEN,
  N8N_WEBHOOK_URL_TEST,
  N8N_WEBHOOK_URL_PROD,
  N8N_ENV = 'TEST',           // TEST | PROD
  N8N_HEADER_KEY,
  N8N_HEADER_VALUE,
  WATCHLIST = 'AAPL,TSLA,PLTR,SPY',
  WINDOW_MIN = '10',
  THRESHLOW = '2',
  THRESHHIGH = '4',
  COOLDOWN_MIN = '5',
  DEDUP_EXTRA = '0.5',
  MARKET_OPEN_CST = '08:30',
  MARKET_CLOSE_CST = '15:00',
  SIM_MODE,                   // "1" o "true" para activar simulador
  IGNORE_MARKET_HOURS,        // "1" o "true" para no bloquear fuera de horario
} = process.env;

const SIM = (SIM_MODE ?? '').toLowerCase() === '1' || (SIM_MODE ?? '').toLowerCase() === 'true';
const IGNORE_HOURS = (IGNORE_MARKET_HOURS ?? '').toLowerCase() === '1' || (IGNORE_MARKET_HOURS ?? '').toLowerCase() === 'true';

const symbols = WATCHLIST.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const wsUrl = `wss://ws.finnhub.io?token=${FINNHUB_TOKEN}`;
const mode = (N8N_ENV || 'TEST').toUpperCase();

const store = new Map(); // { [symbol]: { prices:[{t,p}], lastAlert:{pct,t}, hod, lod, cooldownUntil } }
const toMs = m => Number(m) * 60 * 1000;

// Boot log
console.log('[boot]', {
  mode,
  SIM,
  IGNORE_HOURS,
  symbols,
  node: process.version,
  wd: process.cwd(),
});

// --------- Utilidades ----------
function cdmxNow() { return new Date(); }

function inRegularHours() {
  if (IGNORE_HOURS || SIM) return true;
  const now = cdmxNow();
  const [oh, om] = MARKET_OPEN_CST.split(':').map(Number);
  const [ch, cm] = MARKET_CLOSE_CST.split(':').map(Number);
  const open = new Date(now); open.setHours(oh, om, 0, 0);
  const close = new Date(now); close.setHours(ch, cm, 0, 0);
  return now >= open && now <= close;
}

function pushPrice(s, t, p) {
  const rec = store.get(s) ?? { prices: [], lastAlert: null, hod: p, lod: p, cooldownUntil: 0 };
  rec.prices.push({ t, p });

  // ventana deslizante
  const cutoff = t - toMs(WINDOW_MIN);
  while (rec.prices.length && rec.prices[0].t < cutoff) rec.prices.shift();

  // HOD/LOD
  rec.hod = Math.max(rec.hod ?? p, p);
  rec.lod = Math.min(rec.lod ?? p, p);

  store.set(s, rec);
}

function computeDeltaPct(s) {
  const rec = store.get(s);
  if (!rec || rec.prices.length < 2) return null;
  const first = rec.prices[0].p;
  const last = rec.prices[rec.prices.length - 1].p;
  return ((last - first) / first) * 100;
}

function momentumOk(s) {
  const rec = store.get(s);
  if (!rec) return false;
  const now = rec.prices.at(-1)?.t;
  const cutoff = now - 60_000; // 60s
  let sum = 0, dir = 0, prev = null;
  for (const { t, p } of rec.prices.filter(x => x.t >= cutoff)) {
    if (prev != null) {
      const d = p - prev;
      sum += Math.abs(d / prev) * 100;
      dir += Math.sign(d);
    }
    prev = p;
  }
  return sum >= 0.6 && Math.abs(dir) >= 3;
}

async function fireAlert({ symbol, price, rule, changePct, severity }) {
  const url = mode === 'PROD' ? N8N_WEBHOOK_URL_PROD : N8N_WEBHOOK_URL_TEST;
  if (!url) {
    console.error('[alert] N8N webhook URL no configurada (N8N_WEBHOOK_URL_TEST/PROD)');
    return;
  }

  const headers = { 'content-type': 'application/json' };
  if (N8N_HEADER_KEY && N8N_HEADER_VALUE) headers[N8N_HEADER_KEY] = N8N_HEADER_VALUE;

  const payload = { symbol, price, ts: Date.now(), source: SIM ? 'sim' : 'finnhub', rule, changePct, severity };

  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[alert] Webhook ${mode} ${res.status}:`, text);
    }
  } catch (err) {
    console.error('[alert] error enviando webhook:', err.message);
  }
}

function maybeAlert(s) {
  if (!inRegularHours()) return;
  const rec = store.get(s);
  if (!rec || rec.prices.length < 2) return;

  const now = Date.now();
  if (now < rec.cooldownUntil) return;

  const last = rec.prices.at(-1).p;
  const delta = computeDeltaPct(s);
  const breakout = (last > rec.hod) ? 'HOD' : (last < rec.lod ? 'LOD' : null);
  const momentum = momentumOk(s);

  const lastPct = rec.lastAlert?.pct ?? null;
  const dedupBlock = lastPct != null && Math.abs(delta) < Math.abs(lastPct) + Number(DEDUP_EXTRA);

  let rule = null, severity = 'normal';
  if (breakout) { rule = `breakout_${breakout}`; }
  if (Math.abs(delta) >= Number(THRESHLOW)) { rule = rule ? `${rule}+swing` : 'swing'; }
  if (momentum) { rule = rule ? `${rule}+momentum` : 'momentum'; }

  if (rule && !dedupBlock) {
    if (Math.abs(delta) >= Number(THRESHHIGH)) severity = 'urgent';
    rec.lastAlert = { pct: delta, t: now };
    rec.cooldownUntil = now + toMs(COOLDOWN_MIN);
    store.set(s, rec);

    fireAlert({ symbol: s, price: last, rule, changePct: Number(delta.toFixed(2)), severity })
        .catch(err => console.error('Webhook error', err));
  }
}

// --------- Ingesta de precios ----------
function startSimulator() {
  console.log('SIM MODE ON: generating ticks...');
  const baseBySym = new Map(symbols.map(s => [s, 100 + Math.random() * 50]));

  setInterval(() => {
    for (const s of symbols) {
      let price = baseBySym.get(s);

      // random walk ~±0.1% por segundo
      const driftPct = (Math.random() - 0.5) * 0.2;
      price *= (1 + driftPct / 100);

      // spikes ocasionales 2–5% para probar alertas
      if (Math.random() < 0.05) {
        const spikePct = (Math.random() < 0.5 ? -1 : 1) * (2 + Math.random() * 3);
        price *= (1 + spikePct / 100);
      }

      price = Number(price.toFixed(2));
      baseBySym.set(s, price);

      const t = Date.now();
      pushPrice(s, t, price);
      maybeAlert(s);
    }
  }, 1000);
}

let wsRef = null;

function connectFinnhub() {
  if (!FINNHUB_TOKEN) {
    console.error('[boot] FINNHUB_TOKEN no definido. Usa SIM_MODE=1 para pruebas o configura el token.');
    process.exitCode = 1;
    return;
  }
  const ws = new WebSocket(wsUrl);
  wsRef = ws;
  let hb = null;

  ws.on('open', () => {
    console.log('Finnhub WS connected →', symbols.join(', '));
    symbols.forEach(sym => ws.send(JSON.stringify({ type: 'subscribe', symbol: sym })));
    hb = setInterval(() => ws.ping?.(), 20_000);
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'trade' && Array.isArray(msg.data)) {
        for (const { s, p, t } of msg.data) {
          const ts = typeof t === 'number' ? t : Date.now();
          pushPrice(s, ts, p);
          maybeAlert(s);
        }
      }
    } catch { /* no-op */ }
  });

  const retry = () => {
    if (hb) clearInterval(hb);
    setTimeout(connectFinnhub, 2000 + Math.random() * 3000);
  };

  ws.on('close', retry);
  ws.on('error', retry);
}

// Cierre limpio
function shutdown() {
  console.log('[shutdown] recibiendo señal, cerrando…');
  try { wsRef?.close(); } catch {}
  setTimeout(() => process.exit(0), 250);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// --------- Arranque ----------
if (SIM) {
  startSimulator();
} else {
  connectFinnhub();
}
