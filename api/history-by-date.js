// api/history-by-date.js
// Vercel Serverless Function
// GET /api/history-by-date?symbol=bitcoin&type=crypto&date=2024-03-15&currency=CHF
// Liefert historischen Kurs für ein bestimmtes Datum.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Histor. Punkte werden sehr lange gecacht (sie ändern sich nicht mehr)
const _cache = new Map();
const _inflight = new Map();
const HISTORICAL_TTL = 7 * 24 * 60 * 60 * 1000;  // 7 Tage

function cacheGet(key) {
  const e = _cache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { _cache.delete(key); return null; }
  return e.data;
}
function cacheSet(key, data, ttl = HISTORICAL_TTL) {
  _cache.set(key, { data, expiresAt: Date.now() + ttl });
  if (_cache.size > 500) {
    const now = Date.now();
    for (const [k, v] of _cache) if (v.expiresAt < now) _cache.delete(k);
  }
}
async function withDedup(key, fn) {
  if (_inflight.has(key)) return _inflight.get(key);
  const p = fn().finally(() => _inflight.delete(key));
  _inflight.set(key, p);
  return p;
}

// FX Rate USD → Zielwährung (gleiche Logik wie history.js)
const _fxCache = new Map();
async function usdRate(currency) {
  if (currency === 'USD') return 1;
  const cached = _fxCache.get(currency);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.rate;
  const FALLBACK = { CHF: 0.88, EUR: 0.92, GBP: 0.79 };
  try {
    const r = await fetch(`https://api.coinbase.com/v2/exchange-rates?currency=USD`);
    if (!r.ok) return FALLBACK[currency] || 1;
    const data = await r.json();
    const rate = parseFloat(data?.data?.rates?.[currency]);
    if (!isFinite(rate) || rate <= 0) return FALLBACK[currency] || 1;
    _fxCache.set(currency, { rate, at: Date.now() });
    return rate;
  } catch {
    return FALLBACK[currency] || 1;
  }
}

// ── Crypto via CoinGecko historischer Einzelpreis ──
async function cryptoHistByDate(symbol, date, currency) {
  // CoinGecko format: DD-MM-YYYY
  const [y, m, d] = date.split('-');
  const cgDate = `${d}-${m}-${y}`;
  const key = process.env.COINGECKO_API_KEY;
  const url = `https://api.coingecko.com/api/v3/coins/${symbol}/history?date=${cgDate}${key ? `&x_cg_demo_api_key=${key}` : ''}`;

  const r = await fetch(url);
  if (!r.ok) throw new Error(`CoinGecko ${r.status}`);
  const data = await r.json();
  const priceUsd = data?.market_data?.current_price?.usd;
  if (typeof priceUsd !== 'number' || priceUsd <= 0) throw new Error('Kein Preis verfügbar');

  const rate = await usdRate(currency);
  return { symbol, date, price: priceUsd * rate, currency, source: 'coingecko' };
}

// ── Stock via Alpha Vantage TIME_SERIES_DAILY → Einzelpunkt ──
async function stockHistByDate(symbol, date) {
  const key = process.env.ALPHA_VANTAGE_API_KEY;
  if (!key) throw new Error('ALPHA_VANTAGE_API_KEY fehlt');

  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${symbol}&outputsize=full&apikey=${key}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Alpha Vantage ${r.status}`);
  const data = await r.json();

  if (data.Note || data.Information) throw new Error('Rate-Limit: ' + (data.Note || data.Information));
  const series = data['Time Series (Daily)'];
  if (!series) throw new Error('Keine Daten von Alpha Vantage');

  // Exaktes Datum suchen, sonst nächstes früheres Datum (Wochenende/Feiertag)
  let price = null;
  if (series[date]) {
    price = parseFloat(series[date]['4. close']);
  } else {
    const dates = Object.keys(series).sort().reverse();
    const targetTs = new Date(date).getTime();
    for (const d of dates) {
      if (new Date(d).getTime() <= targetTs) {
        price = parseFloat(series[d]['4. close']);
        break;
      }
    }
  }
  if (!price || price <= 0) throw new Error('Kein Preis am Datum');
  return { symbol, date, price, currency: 'USD', source: 'alphavantage' };
}

// ── Twelve Data Fallback ──
async function stockHistByDateTwelve(symbol, date) {
  const key = process.env.TWELVE_DATA_API_KEY;
  if (!key) throw new Error('TWELVE_DATA_API_KEY fehlt');

  const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=1day&start_date=${date}&end_date=${date}&apikey=${key}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Twelve Data ${r.status}`);
  const data = await r.json();
  if (data.status === 'error') throw new Error(data.message || 'Twelve Data Error');

  const values = data.values;
  if (!Array.isArray(values) || !values.length) throw new Error('Keine Daten von Twelve Data');
  const price = parseFloat(values[0].close);
  if (!price || price <= 0) throw new Error('Kein Preis');
  return { symbol, date, price, currency: 'USD', source: 'twelvedata' };
}

// ── HANDLER ──────────────────────────────────────────────────
export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { symbol, type, date, currency = 'USD' } = req.query;
  const cur = currency.toUpperCase();

  if (!symbol) return res.status(400).json({ error: 'symbol ist erforderlich' });
  if (!type) return res.status(400).json({ error: 'type ist erforderlich' });
  if (!date) return res.status(400).json({ error: 'date ist erforderlich (YYYY-MM-DD)' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date muss YYYY-MM-DD sein' });
  }

  // ETF/Metal nicht unterstützt
  if (type === 'etf' || type === 'metal') {
    return res.status(404).json({ error: `Historie für ${type} nicht verfügbar` });
  }

  const cacheKey = `hbd:${type}:${symbol.toLowerCase()}:${date}:${cur}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cached);
  }

  try {
    const result = await withDedup(cacheKey, async () => {
      if (type === 'crypto') {
        return await cryptoHistByDate(symbol, date, cur);
      }
      if (type === 'stock') {
        try {
          const r = await stockHistByDate(symbol, date);
          if (cur !== 'USD') {
            const rate = await usdRate(cur);
            r.price = r.price * rate;
            r.currency = cur;
          }
          return r;
        } catch (e1) {
          console.warn('[hbd] alpha failed:', e1.message);
          try {
            const r = await stockHistByDateTwelve(symbol, date);
            if (cur !== 'USD') {
              const rate = await usdRate(cur);
              r.price = r.price * rate;
              r.currency = cur;
            }
            return r;
          } catch (e2) {
            const err = new Error('Beide Provider fehlgeschlagen');
            err.status = 404;
            err.detail = { alpha: e1.message, twelve: e2.message };
            throw err;
          }
        }
      }
      throw new Error('Unbekannter type');
    });

    cacheSet(cacheKey, result);
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(result);
  } catch (e) {
    if (e.status === 404) {
      // Negative Result kurz cachen (5 min) → kein Hammer-Retry
      cacheSet(cacheKey, null, 5 * 60 * 1000);
      return res.status(404).json({ error: e.message, detail: e.detail });
    }
    console.error('[api/history-by-date]', e);
    return res.status(500).json({ error: `Interner Fehler: ${e.message}` });
  }
}
