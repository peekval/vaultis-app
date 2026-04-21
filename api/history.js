// api/history.js
// Vercel Serverless Function
// GET /api/history?symbol=bitcoin&type=crypto&range=1m&currency=CHF

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── Cache + Dedup ──
// - cache: key → { data, expiresAt }
// - inflight: key → Promise
const _cache = new Map();
const _inflight = new Map();

// TTLs pro Range
const TTL_MS = {
  '7d':  3 * 60 * 1000,   // 3 min
  '1m': 10 * 60 * 1000,   // 10 min
  '6m': 30 * 60 * 1000,   // 30 min
  '1y': 60 * 60 * 1000,   // 60 min
  'all':2 * 60 * 60 * 1000, // 2 h
};

function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _cache.delete(key); return null; }
  return entry.data;
}
function cacheSet(key, data, ttl) {
  _cache.set(key, { data, expiresAt: Date.now() + ttl });
  // Alte Einträge aufräumen (soft cap ~200)
  if (_cache.size > 200) {
    const now = Date.now();
    for (const [k, v] of _cache) { if (v.expiresAt < now) _cache.delete(k); }
  }
}
async function withDedup(key, fn) {
  if (_inflight.has(key)) return _inflight.get(key);
  const p = fn().finally(() => _inflight.delete(key));
  _inflight.set(key, p);
  return p;
}

const RANGE_DAYS = { '7d': 7, '1m': 30, '6m': 180, '1y': 365, 'all': 1825 };

const ALPHA_CFG = {
  '7d': { fn: 'TIME_SERIES_INTRADAY&interval=60min', key: 'Time Series (60min)', outputsize: 'full' },
  '1m': { fn: 'TIME_SERIES_DAILY',                  key: 'Time Series (Daily)', outputsize: 'compact' },
  '6m': { fn: 'TIME_SERIES_DAILY',                  key: 'Time Series (Daily)', outputsize: 'full' },
  '1y': { fn: 'TIME_SERIES_DAILY',                  key: 'Time Series (Daily)', outputsize: 'full' },
  'all':{ fn: 'TIME_SERIES_WEEKLY',                 key: 'Weekly Time Series',  outputsize: 'full' },
};

const TD_CFG = {
  '7d': { interval: '1h',    outputsize: 168 },
  '1m': { interval: '1day',  outputsize: 30  },
  '6m': { interval: '1day',  outputsize: 180 },
  '1y': { interval: '1day',  outputsize: 365 },
  'all':{ interval: '1week', outputsize: 1000 },
};

// ── FX: USD → Zielwährung ─────────────────────────────────────
async function usdRate(currency) {
  if (currency === 'USD') return 1;
  const FALLBACK = { CHF: 0.88, EUR: 0.92, GBP: 0.79 };
  try {
    const r = await fetch('https://api.coinbase.com/v2/exchange-rates?currency=USD',
      { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error('fx failed');
    const d = await r.json();
    const v = parseFloat(d?.data?.rates?.[currency]);
    return isNaN(v) ? (FALLBACK[currency] ?? 1) : v;
  } catch {
    return FALLBACK[currency] ?? 1;
  }
}

// ── CRYPTO via CoinGecko /market_chart ────────────────────────
async function fetchCrypto(symbol, range, currency) {
  const days = RANGE_DAYS[range];
  const cur  = currency.toLowerCase();
  const key  = process.env.COINGECKO_API_KEY;
  const url  = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(symbol)}/market_chart?vs_currency=${cur}&days=${days}`;

  const r = await fetch(url, {
    headers: key ? { 'x-cg-demo-api-key': key } : {},
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`CoinGecko HTTP ${r.status}`);

  const d = await r.json();
  if (!Array.isArray(d?.prices) || d.prices.length === 0) {
    throw new Error('CoinGecko: keine Preisdaten');
  }

  // d.prices: [[unix_ms, price], ...]
  const raw = d.prices
    .map(([ms, price]) => {
      const dt = new Date(ms);
      const date = range === '7d'
        ? dt.toISOString().slice(0, 16)   // YYYY-MM-DDTHH:mm
        : dt.toISOString().slice(0, 10);  // YYYY-MM-DD
      return { date, price };
    })
    .filter(p => typeof p.price === 'number' && p.price > 0);

  // Daily: einen Punkt pro Tag (letzten = Tages-Close)
  let points;
  if (range === '7d') {
    points = raw;
  } else {
    const byDate = new Map();
    for (const p of raw) byDate.set(p.date, p);
    points = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  return { symbol, type: 'crypto', range, source: 'coingecko', points };
}

// ── STOCK via Alpha Vantage ───────────────────────────────────
async function fetchStockAlpha(symbol, range) {
  const key = process.env.ALPHA_VANTAGE_API_KEY;
  if (!key) throw new Error('ALPHA_VANTAGE_API_KEY fehlt');

  const cfg = ALPHA_CFG[range];
  const url = `https://www.alphavantage.co/query?function=${cfg.fn}&symbol=${encodeURIComponent(symbol)}&outputsize=${cfg.outputsize}&apikey=${key}`;

  const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`Alpha Vantage HTTP ${r.status}`);

  const d = await r.json();

  // Alpha Vantage gibt Fehler im JSON-Body zurück, nicht per HTTP-Status
  if (d['Error Message']) throw new Error(`Alpha Vantage: ${d['Error Message']}`);
  if (d['Note'])          throw new Error(`Alpha Vantage Rate-Limit: ${d['Note']}`);
  if (d['Information'])   throw new Error(`Alpha Vantage: ${d['Information']}`);

  const series = d[cfg.key];
  if (!series || typeof series !== 'object') {
    throw new Error(`Alpha Vantage: Serie "${cfg.key}" fehlt`);
  }

  const intraday  = range === '7d';
  const cutoffMs  = Date.now() - RANGE_DAYS[range] * 86400000;

  const points = Object.entries(series)
    .map(([dateStr, entry]) => {
      const price = parseFloat(entry['4. close']);
      const norm  = dateStr.replace(' ', 'T');
      return { _ms: new Date(norm).getTime(), date: intraday ? norm.slice(0, 16) : norm.slice(0, 10), price };
    })
    .filter(p => !isNaN(p.price) && p.price > 0 && p._ms >= cutoffMs)
    .sort((a, b) => a._ms - b._ms)
    .map(({ date, price }) => ({ date, price }));

  if (points.length === 0) throw new Error('Alpha Vantage: keine Punkte im Range');

  return { symbol, type: 'stock', range, source: 'alphavantage', points };
}

// ── STOCK via Twelve Data (fallback) ─────────────────────────
async function fetchStockTwelve(symbol, range) {
  const key = process.env.TWELVE_DATA_API_KEY;
  if (!key) throw new Error('TWELVE_DATA_API_KEY fehlt');

  const cfg = TD_CFG[range];
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${cfg.interval}&outputsize=${cfg.outputsize}&apikey=${key}`;

  const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`Twelve Data HTTP ${r.status}`);

  const d = await r.json();
  if (d.status === 'error') throw new Error(`Twelve Data: ${d.message}`);
  if (!Array.isArray(d.values)) throw new Error('Twelve Data: keine values');

  const intraday = range === '7d';

  const points = d.values
    .map(v => {
      const norm  = v.datetime.replace(' ', 'T');
      const price = parseFloat(v.close);
      return { _ms: new Date(norm).getTime(), date: intraday ? norm.slice(0, 16) : norm.slice(0, 10), price };
    })
    .filter(p => !isNaN(p.price) && p.price > 0)
    .sort((a, b) => a._ms - b._ms)
    .map(({ date, price }) => ({ date, price }));

  if (points.length === 0) throw new Error('Twelve Data: keine Punkte');

  return { symbol, type: 'stock', range, source: 'twelvedata', points };
}

// ── HANDLER ──────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS für jeden Response
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  // OPTIONS Preflight
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { symbol, type, range = '1m', currency = 'USD' } = req.query;
  const cur = currency.toUpperCase();

  // Validation
  if (!symbol) return res.status(400).json({ error: 'symbol ist erforderlich' });
  if (!type)   return res.status(400).json({ error: 'type ist erforderlich' });
  if (!RANGE_DAYS[range]) {
    return res.status(400).json({ error: `range muss 7d|1m|6m|1y|all sein (erhalten: ${range})` });
  }
  if (!['crypto', 'stock', 'etf', 'metal'].includes(type)) {
    return res.status(400).json({ error: `type muss crypto|stock|etf|metal sein (erhalten: ${type})` });
  }

  // ETF / Metal: kein zuverlässiger Provider verfügbar
  if (type === 'etf') {
    return res.status(404).json({ error: 'ETF-Historie aktuell nicht verfügbar' });
  }
  if (type === 'metal') {
    return res.status(404).json({ error: 'Metal-Historie aktuell nicht verfügbar' });
  }

  // ── Cache-Check ──
  const cacheKey = `hist:${type}:${symbol.toLowerCase()}:${range}:${cur}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cached);
  }

  try {
    // Dedup: falls ein zweiter Request denselben Key gleichzeitig will, teilen sie sich den Promise
    const result = await withDedup(cacheKey, async () => {
      if (type === 'crypto') {
        return await fetchCrypto(symbol, range, cur);
      }
      if (type === 'stock') {
        try {
          return await fetchStockAlpha(symbol, range);
        } catch (alphaErr) {
          console.warn(`[history] alphavantage failed for ${symbol}: ${alphaErr.message} — trying twelvedata`);
          try {
            return await fetchStockTwelve(symbol, range);
          } catch (tdErr) {
            console.warn(`[history] twelvedata also failed for ${symbol}: ${tdErr.message}`);
            const err = new Error(`Historie für ${symbol} nicht verfügbar`);
            err.status = 404;
            err.detail = { alphavantage: alphaErr.message, twelvedata: tdErr.message };
            throw err;
          }
        }
      }
      throw new Error('Unbekannter type');
    });

    // Erfolgreich — cachen
    cacheSet(cacheKey, result, TTL_MS[range] || 10 * 60 * 1000);
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(result);

  } catch (e) {
    if (e.status === 404) {
      return res.status(404).json({ error: e.message, detail: e.detail });
    }
    console.error('[api/history] unexpected:', e);
    return res.status(500).json({ error: `Interner Fehler: ${e.message}` });
  }
}
