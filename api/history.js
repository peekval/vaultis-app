// api/history.js
// GET /api/history?symbol=bitcoin&type=crypto&range=1m&currency=CHF

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const RANGE_DAYS = { '7d': 7, '1m': 30, '6m': 180, '1y': 365 };

const ALPHA_CFG = {
  '7d': { fn: 'TIME_SERIES_INTRADAY&interval=60min', key: 'Time Series (60min)', outputsize: 'full' },
  '1m': { fn: 'TIME_SERIES_DAILY', key: 'Time Series (Daily)', outputsize: 'compact' },
  '6m': { fn: 'TIME_SERIES_DAILY', key: 'Time Series (Daily)', outputsize: 'full' },
  '1y': { fn: 'TIME_SERIES_DAILY', key: 'Time Series (Daily)', outputsize: 'full' },
};

function setCors(res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
}

async function readJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const data = await readJson(res);

  if (!res.ok) {
    throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
  }

  return data;
}

// ── FX: USD → Zielwährung ─────────────────────────────────────
async function usdRate(currency) {
  if (currency === 'USD') return 1;

  const FALLBACK = { CHF: 0.88, EUR: 0.92, GBP: 0.79 };

  try {
    const d = await fetchJson('https://api.coinbase.com/v2/exchange-rates?currency=USD');
    const v = parseFloat(d?.data?.rates?.[currency]);
    return Number.isFinite(v) && v > 0 ? v : (FALLBACK[currency] || 1);
  } catch {
    return FALLBACK[currency] || 1;
  }
}

// ── CRYPTO via CoinGecko /market_chart ────────────────────────
async function fetchCrypto(symbol, range, currency) {
  const days = RANGE_DAYS[range];
  const cur = currency.toLowerCase();
  const key = process.env.COINGECKO_API_KEY;

  const d = await fetchJson(
    `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(symbol)}/market_chart?vs_currency=${cur}&days=${days}`,
    key ? { headers: { 'x-cg-demo-api-key': key } } : {}
  );

  if (!Array.isArray(d?.prices) || d.prices.length === 0) {
    throw new Error('CoinGecko: keine Preisdaten');
  }

  const raw = d.prices
    .map(([ms, price]) => {
      const dt = new Date(ms);
      const date = range === '7d'
        ? dt.toISOString().slice(0, 16)
        : dt.toISOString().slice(0, 10);
      return { date, price };
    })
    .filter(p => typeof p.price === 'number' && p.price > 0);

  let points;
  if (range === '7d') {
    points = raw;
  } else {
    const byDate = new Map();
    for (const p of raw) byDate.set(p.date, p);
    points = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  return {
    symbol,
    type: 'crypto',
    range,
    currency,
    source: 'coingecko',
    points,
  };
}

// ── STOCK / ETF via Alpha Vantage ─────────────────────────────
async function fetchAlpha(symbol, range, outCurrency, type) {
  const key = process.env.ALPHA_VANTAGE_API_KEY;
  if (!key) throw new Error('ALPHA_VANTAGE_API_KEY fehlt');

  const cfg = ALPHA_CFG[range];

  const d = await fetchJson(
    `https://www.alphavantage.co/query?function=${cfg.fn}&symbol=${encodeURIComponent(symbol)}&outputsize=${cfg.outputsize}&apikey=${key}`
  );

  if (d['Error Message']) throw new Error(`Alpha Vantage: ${d['Error Message']}`);
  if (d['Note']) throw new Error(`Alpha Vantage Rate-Limit: ${d['Note']}`);
  if (d['Information']) throw new Error(`Alpha Vantage: ${d['Information']}`);

  const series = d[cfg.key];
  if (!series || typeof series !== 'object') {
    throw new Error(`Alpha Vantage: Serie "${cfg.key}" fehlt`);
  }

  const intraday = range === '7d';
  const cutoffMs = Date.now() - RANGE_DAYS[range] * 86400000;

  let points = Object.entries(series)
    .map(([dateStr, entry]) => {
      const priceUsd = parseFloat(entry['4. close']);
      const norm = dateStr.replace(' ', 'T');
      return {
        _ms: new Date(norm).getTime(),
        date: intraday ? norm.slice(0, 16) : norm.slice(0, 10),
        price: priceUsd,
      };
    })
    .filter(p => Number.isFinite(p.price) && p.price > 0 && p._ms >= cutoffMs)
    .sort((a, b) => a._ms - b._ms);

  if (!points.length) {
    throw new Error('Alpha Vantage: keine Punkte im Range');
  }

  if (outCurrency !== 'USD') {
    const fx = await usdRate(outCurrency);
    points = points.map(p => ({
      _ms: p._ms,
      date: p.date,
      price: p.price * fx,
    }));
  }

  return {
    symbol,
    type,
    range,
    currency: outCurrency,
    source: 'alphavantage',
    points: points.map(({ date, price }) => ({ date, price })),
  };
}

// ── HANDLER ──────────────────────────────────────────────────
export default async function handler(req, res) {
  try {
    setCors(res);

    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const symbol = String(req.query.symbol || '').trim();
    const type = String(req.query.type || '').trim().toLowerCase();
    const range = String(req.query.range || '1m').trim();
    const currency = String(req.query.currency || 'USD').trim().toUpperCase();

    if (!symbol) return res.status(400).json({ error: 'symbol ist erforderlich' });
    if (!type) return res.status(400).json({ error: 'type ist erforderlich' });

    if (!RANGE_DAYS[range]) {
      return res.status(400).json({ error: `range muss 7d|1m|6m|1y sein (erhalten: ${range})` });
    }

    if (!['crypto', 'stock', 'etf', 'metal'].includes(type)) {
      return res.status(400).json({ error: `type muss crypto|stock|etf|metal sein (erhalten: ${type})` });
    }

    if (type === 'metal') {
      return res.status(404).json({ error: 'Metal-Historie aktuell nicht verfügbar' });
    }

    if (type === 'crypto') {
      const result = await fetchCrypto(symbol, range, currency);
      return res.status(200).json(result);
    }

    if (type === 'stock' || type === 'etf') {
      const result = await fetchAlpha(symbol, range, currency, type);
      return res.status(200).json(result);
    }

    return res.status(400).json({ error: 'Unbekannter type' });
  } catch (e) {
    console.error('[api/history] unexpected:', e);
    return res.status(500).json({ error: `Interner Fehler: ${e.message}` });
  }
}
