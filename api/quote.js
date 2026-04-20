// /api/quote.js
// Vercel Serverless Function
// GET /api/quote?symbol=bitcoin&type=crypto&currency=CHF

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const METAL_SYMBOL_MAP = {
  gold: 'gold',
  silver: 'silver',
  platinum: 'platinum',
  palladium: 'palladium',
};

const STOCK_SYMBOL_MAP = {
  'BRK-B': 'BRK.B',
  'BRK.B': 'BRK.B',
};

function setCors(res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
}

async function fetchJson(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      const msg =
        data?.error ||
        data?.message ||
        data?.detail ||
        data?.status ||
        `HTTP ${res.status}`;
      throw new Error(msg);
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

// USD -> Zielwaehrung
async function usdRate(currency) {
  if (!currency || currency === 'USD') return 1;

  const fallback = {
    CHF: 0.88,
    EUR: 0.92,
    GBP: 0.79,
  };

  try {
    const data = await fetchJson(
      'https://api.coinbase.com/v2/exchange-rates?currency=USD',
      {},
      5000
    );

    const v = parseFloat(data?.data?.rates?.[currency]);
    if (Number.isFinite(v) && v > 0) return v;

    return fallback[currency] || 1;
  } catch {
    return fallback[currency] || 1;
  }
}

// ---------- CRYPTO ----------
async function quoteCrypto(symbol, currency) {
  const key = process.env.COINGECKO_API_KEY;

  const url =
    `https://api.coingecko.com/api/v3/simple/price` +
    `?ids=${encodeURIComponent(symbol)}` +
    `&vs_currencies=${currency.toLowerCase()}` +
    `&include_24hr_change=true`;

  const headers = key ? { 'x-cg-demo-api-key': key } : {};
  const data = await fetchJson(url, { headers }, 10000);

  const row = data?.[symbol];
  if (!row) throw new Error(`Kein Crypto-Kurs fuer ${symbol}`);

  const lc = currency.toLowerCase();
  const price = parseFloat(row?.[lc]);
  const change24h = parseFloat(row?.[`${lc}_24h_change`]);

  if (!(price > 0)) {
    throw new Error(`Ungueltiger Crypto-Kurs fuer ${symbol}`);
  }

  return {
    price,
    change24h: Number.isFinite(change24h) ? change24h : 0,
    currency,
    source: 'coingecko',
  };
}

// ---------- STOCK / ETF via Finnhub ----------
async function quoteStockFinnhub(symbol, currency) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) throw new Error('FINNHUB_API_KEY fehlt');

  const mapped = STOCK_SYMBOL_MAP[symbol] || symbol;
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(mapped)}&token=${key}`;

  const data = await fetchJson(url, {}, 10000);

  const current = parseFloat(data?.c);
  const previousClose = parseFloat(data?.pc);

  if (!(current > 0)) {
    throw new Error(`Kein Finnhub-Kurs fuer ${symbol}`);
  }

  if (currency === 'USD') {
    const change24h =
      previousClose > 0 ? ((current - previousClose) / previousClose) * 100 : 0;

    return {
      price: current,
      change24h,
      currency: 'USD',
      source: 'finnhub',
    };
  }

  const fx = await usdRate(currency);
  const converted = current * fx;
  const prevConverted = previousClose > 0 ? previousClose * fx : 0;
  const change24h =
    prevConverted > 0 ? ((converted - prevConverted) / prevConverted) * 100 : 0;

  return {
    price: converted,
    change24h,
    currency,
    source: 'finnhub',
  };
}

// ---------- STOCK / ETF fallback via Twelve Data ----------
async function quoteStockTwelve(symbol, currency) {
  const key = process.env.TWELVE_DATA_API_KEY;
  if (!key) throw new Error('TWELVE_DATA_API_KEY fehlt');

  const mapped = STOCK_SYMBOL_MAP[symbol] || symbol;
  const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(mapped)}&apikey=${key}`;

  const data = await fetchJson(url, {}, 10000);

  if (data?.status === 'error') {
    throw new Error(data?.message || `Twelve Data Fehler fuer ${symbol}`);
  }

  const rawPrice = parseFloat(data?.close || data?.price);
  const rawPrev = parseFloat(data?.previous_close);
  const providerCurrency = String(data?.currency || 'USD').toUpperCase();

  if (!(rawPrice > 0)) {
    throw new Error(`Kein Twelve-Data-Kurs fuer ${symbol}`);
  }

  let price = rawPrice;
  let previousClose = rawPrev;
  let outCurrency = providerCurrency;

  if (providerCurrency === 'USD' && currency !== 'USD') {
    const fx = await usdRate(currency);
    price = rawPrice * fx;
    previousClose = rawPrev > 0 ? rawPrev * fx : 0;
    outCurrency = currency;
  }

  const change24h =
    previousClose > 0 ? ((price - previousClose) / previousClose) * 100 : 0;

  return {
    price,
    change24h,
    currency: outCurrency,
    source: 'twelvedata',
  };
}

// ---------- METALS via Metals.dev ----------
async function quoteMetal(symbol, currency) {
  const apiKey = process.env.METALS_DEV_API_KEY;
  if (!apiKey) throw new Error('METALS_DEV_API_KEY fehlt');

  const metal = METAL_SYMBOL_MAP[symbol];
  if (!metal) throw new Error(`Unbekanntes Metall: ${symbol}`);

  // Versuch 1: Spot
  const spotUrl =
    `https://api.metals.dev/v1/metal/spot` +
    `?api_key=${encodeURIComponent(apiKey)}` +
    `&metal=${encodeURIComponent(metal)}` +
    `&currency=${encodeURIComponent(currency)}` +
    `&unit=toz`;

  try {
    const data = await fetchJson(
      spotUrl,
      { headers: { Accept: 'application/json' } },
      10000
    );

    const price =
      parseFloat(data?.spot_price) ||
      parseFloat(data?.price) ||
      parseFloat(data?.spot) ||
      parseFloat(data?.rate);

    const change24h =
      parseFloat(data?.change_percentage) ||
      parseFloat(data?.change_percent) ||
      parseFloat(data?.change_pct);

    if (!(price > 0)) {
      throw new Error('Spot-Antwort ohne gueltigen Preis');
    }

    return {
      price,
      change24h: Number.isFinite(change24h) ? change24h : 0,
      currency,
      source: 'metals.dev/spot',
    };
  } catch (_) {
    // Versuch 2: latest fallback
    const latestUrl =
      `https://api.metals.dev/v1/latest` +
      `?api_key=${encodeURIComponent(apiKey)}` +
      `&currency=${encodeURIComponent(currency)}` +
      `&unit=toz`;

    const data = await fetchJson(
      latestUrl,
      { headers: { Accept: 'application/json' } },
      10000
    );

    const price = parseFloat(data?.metals?.[metal]);

    if (!(price > 0)) {
      throw new Error(`Kein Metal-Kurs fuer ${symbol}`);
    }

    return {
      price,
      change24h: 0,
      currency: String(data?.currency || currency || 'USD').toUpperCase(),
      source: 'metals.dev/latest',
    };
  }
}

// ---------- HANDLER ----------
export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const symbol = String(req.query.symbol || '').trim();
  const type = String(req.query.type || '').trim().toLowerCase();
  const currency = String(req.query.currency || 'USD').trim().toUpperCase();

  if (!symbol) {
    return res.status(400).json({ error: 'symbol ist erforderlich' });
  }

  if (!type) {
    return res.status(400).json({ error: 'type ist erforderlich' });
  }

  try {
    if (type === 'crypto') {
      const q = await quoteCrypto(symbol, currency);
      return res.status(200).json(q);
    }

    if (type === 'stock' || type === 'etf') {
      try {
        const q = await quoteStockFinnhub(symbol, currency);
        return res.status(200).json(q);
      } catch (finnErr) {
        console.warn(`[quote] finnhub failed for ${symbol}: ${finnErr.message}`);
        const q = await quoteStockTwelve(symbol, currency);
        return res.status(200).json(q);
      }
    }

    if (type === 'metal') {
      const q = await quoteMetal(symbol, currency);
      return res.status(200).json(q);
    }

    return res.status(400).json({ error: `Unbekannter type: ${type}` });
  } catch (e) {
    console.error('[api/quote] failed:', e);
    return res.status(500).json({
      error: e?.message || 'unknown error',
      code: 'QUOTE_FAILED',
    });
  }
}
