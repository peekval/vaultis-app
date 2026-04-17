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

const TD_CFG = {
  '7d': { interval: '1h', outputsize: 168 },
  '1m': { interval: '1day', outputsize: 30 },
  '6m': { interval: '1day', outputsize: 180 },
  '1y': { interval: '1day', outputsize: 365 },
};

// CRYPTO
async function fetchCrypto(symbol, range, currency) {
  const days = RANGE_DAYS[range];
  const cur = currency.toLowerCase();

  const url = `https://api.coingecko.com/api/v3/coins/${symbol}/market_chart?vs_currency=${cur}&days=${days}`;

  const r = await fetch(url);
  if (!r.ok) throw new Error(`CoinGecko HTTP ${r.status}`);

  const d = await r.json();
  if (!Array.isArray(d.prices)) throw new Error('Keine Daten');

  const raw = d.prices.map(([ms, price]) => {
    const dt = new Date(ms);
    return {
      date: range === '7d'
        ? dt.toISOString().slice(0, 16)
        : dt.toISOString().slice(0, 10),
      price
    };
  });

  if (range === '7d') return { symbol, type: 'crypto', range, source: 'coingecko', points: raw };

  const byDate = new Map();
  raw.forEach(p => byDate.set(p.date, p));
  const points = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

  return { symbol, type: 'crypto', range, source: 'coingecko', points };
}

// STOCK (Alpha Vantage)
async function fetchStockAlpha(symbol, range) {
  const key = process.env.ALPHA_VANTAGE_API_KEY;
  if (!key) throw new Error('Alpha Key fehlt');

  const cfg = ALPHA_CFG[range];
  const url = `https://www.alphavantage.co/query?function=${cfg.fn}&symbol=${symbol}&outputsize=${cfg.outputsize}&apikey=${key}`;

  const r = await fetch(url);
  const d = await r.json();

  const series = d[cfg.key];
  if (!series) throw new Error('Keine Alpha Daten');

  const cutoff = Date.now() - RANGE_DAYS[range] * 86400000;
  const intraday = range === '7d';

  const points = Object.entries(series)
    .map(([date, val]) => {
      const price = parseFloat(val['4. close']);
      const t = new Date(date.replace(' ', 'T')).getTime();
      return {
        _t: t,
        date: intraday ? date.slice(0, 16) : date.slice(0, 10),
        price
      };
    })
    .filter(p => p._t >= cutoff && p.price > 0)
    .sort((a, b) => a._t - b._t)
    .map(p => ({ date: p.date, price: p.price }));

  return { symbol, type: 'stock', range, source: 'alphavantage', points };
}

// STOCK fallback
async function fetchStockTwelve(symbol, range) {
  const key = process.env.TWELVE_DATA_API_KEY;
  if (!key) throw new Error('Twelve Key fehlt');

  const cfg = TD_CFG[range];
  const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${cfg.interval}&outputsize=${cfg.outputsize}&apikey=${key}`;

  const r = await fetch(url);
  const d = await r.json();

  if (!Array.isArray(d.values)) throw new Error('Keine Twelve Daten');

  const intraday = range === '7d';

  const points = d.values
    .map(v => ({
      _t: new Date(v.datetime.replace(' ', 'T')).getTime(),
      date: intraday ? v.datetime.slice(0, 16) : v.datetime.slice(0, 10),
      price: parseFloat(v.close)
    }))
    .sort((a, b) => a._t - b._t)
    .map(p => ({ date: p.date, price: p.price }));

  return { symbol, type: 'stock', range, source: 'twelvedata', points };
}

// HANDLER
export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { symbol, type, range = '1m', currency = 'USD' } = req.query;

  if (!symbol) return res.status(400).json({ error: 'symbol fehlt' });
  if (!type) return res.status(400).json({ error: 'type fehlt' });

  try {
    if (type === 'crypto') {
      return res.status(200).json(await fetchCrypto(symbol, range, currency));
    }

    if (type === 'stock') {
      try {
        return res.status(200).json(await fetchStockAlpha(symbol, range));
      } catch {
        return res.status(200).json(await fetchStockTwelve(symbol, range));
      }
    }

    return res.status(404).json({ error: 'type nicht unterstützt' });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
