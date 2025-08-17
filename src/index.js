import 'dotenv/config';
import fetch from 'node-fetch';
import WebSocket from 'ws';

const {
  FINNHUB_TOKEN, N8N_WEBHOOK_URL, WATCHLIST,
  WINDOW_MIN = 10, THRESHLOW = 2, THRESHHIGH = 4,
  COOLDOWN_MIN = 5, DEDUP_EXTRA = 0.5,
  MARKET_OPEN_CST = '08:30', MARKET_CLOSE_CST = '15:00'
} = process.env;

const symbols = WATCHLIST.split(',').map(s => s.trim().toUpperCase());
const wsUrl = `wss://ws.finnhub.io?token=${FINNHUB_TOKEN}`;

const store = new Map();         // por símbolo: { prices: [{t, p}], lastAlert: {pct, t}, hod, lod, cooldownUntil }
const toMs = m => Number(m) * 60 * 1000;

function cdmxNow() {
  return new Date(); // el host ya corre en CDMX; si no, ajustar con tz
}

function inRegularHours() {
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
  return sum >= 0.6 && Math.abs(dir) >= 3; // simple, ajustable
}

async function fireAlert({ symbol, price, rule, changePct, severity }) {
  const payload = { symbol, price, ts: Date.now(), source: 'finnhub', rule, changePct, severity };
  await fetch(N8N_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
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

function connect() {
  const ws = new WebSocket(wsUrl);
  let hb = null;

  ws.on('open', () => {
    console.log('WS connected');
    // suscribir símbolos
    symbols.forEach(sym => ws.send(JSON.stringify({ type: 'subscribe', symbol: sym })));
    // heartbeat para detectar caídas silenciosas
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
    } catch (e) { /* no-op */ }
  });

  const retry = () => {
    if (hb) clearInterval(hb);
    setTimeout(connect, 2000 + Math.random() * 3000); // backoff simple
  };

  ws.on('close', retry);
  ws.on('error', retry);
}

connect();
