// api/quote.js
// GET /api/quote?symbol=AAPL&type=stock&currency=CHF

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
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

async function cryptoQuote(id, currency) {
  const cur = currency.toLowerCase();
  const key = process.env.COINGECKO_API_KEY;

  const d = await fetchJson(
    `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=${cur},usd&include_24hr_change=true`,
    key ? { headers: { 'x-cg-demo-api-key': key } } : {}
  );

  const entry = d?.[id];
  if (!entry) return null;

  const price = entry[cur] ?? entry.usd;
  if (typeof price !== 'number' || price <= 0) return null;

  return {
    symbol: id,
    type: 'crypto',
    price,
    currency,
    change24h: entry[`${cur}_24h_change`] ?? entry.usd_24h_change ?? 0,
    source: 'coingecko',
    lastUpdated: Date.now(),
  };
}

async function stockQuote(symbol, type, currency) {
  const finnKey = process.env.FINNHUB_API_KEY;

  if (finnKey) {
    try {
      const d = await fetchJson(
        `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${finnKey}`
      );

      if (typeof d?.c === 'number' && d.c > 0) {
        let price = d.c;
        let prev = typeof d.pc === 'number' ? d.pc : 0;
        let outCur = 'USD';

        if (currency !== 'USD') {
          const rate = await usdRate(currency);
          price = price * rate;
          prev = prev > 0 ? prev * rate : 0;
          outCur = currency;
        }

        const chg = prev > 0 ? ((price - prev) / prev) * 100 : 0;

        return {
          symbol,
          type,
          price,
          currency: outCur,
          change24h: chg,
          source: 'finnhub',
          lastUpdated: (d.t || Date.now() / 1000) * 1000,
        };
      }
    } catch (e) {
      console.warn('[stock] finnhub:', e.message);
    }
  }

  try {
    const d = await fetchJson(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
    );

    const result = d?.chart?.result?.[0];
    const meta = result?.meta;

    const priceUsd = parseFloat(meta?.regularMarketPrice);
    const prevUsd = parseFloat(meta?.previousClose);

    if (!(priceUsd > 0)) return null;

    let price = priceUsd;
    let prev = prevUsd;
    let outCur = 'USD';

    if (currency !== 'USD') {
      const rate = await usdRate(currency);
      price = priceUsd * rate;
      prev = prevUsd > 0 ? prevUsd * rate : 0;
      outCur = currency;
    }

    const chg = prev > 0 ? ((price - prev) / prev) * 100 : 0;

    return {
      symbol,
      type,
      price,
      currency: outCur,
      change24h: chg,
      source: 'yahoo',
      lastUpdated: Date.now(),
    };
  } catch (e) {
    console.warn('[stock] yahoo:', e.message);
    return null;
  }
}

const METAL_SYMBOL_MAP = {
  gold: 'gold',
  silver: 'silver',
  platinum: 'platinum',
  palladium: 'palladium',
};

async function metalQuote(id, currency) {
  const apiKey = process.env.METALS_DEV_API_KEY;
  if (!apiKey) {
    throw new Error('METALS_DEV_API_KEY fehlt');
  }

  const metal = METAL_SYMBOL_MAP[String(id || '').toLowerCase()];
  if (!metal) return null;

  try {
    const d = await fetchJson(
      `https://api.metals.dev/v1/metal/spot?api_key=${encodeURIComponent(apiKey)}&metal=${encodeURIComponent(metal)}&currency=${encodeURIComponent(currency)}&unit=toz`,
      { headers: { Accept: 'application/json' } }
    );

    const price =
      parseFloat(d?.spot_price) ||
      parseFloat(d?.price) ||
      parseFloat(d?.spot) ||
      parseFloat(d?.rate);

    const chg =
      parseFloat(d?.change_percentage) ||
      parseFloat(d?.change_percent) ||
      parseFloat(d?.change_pct);

    if (price > 0) {
      return {
        symbol: id,
        type: 'metal',
        price,
        currency,
        change24h: Number.isFinite(chg) ? chg : 0,
        source: 'metals.dev/spot',
        lastUpdated: Date.now(),
      };
    }
  } catch (e) {
    console.warn('[metal] metals.dev spot:', e.message);
  }

  try {
    const d = await fetchJson(
      `https://api.metals.dev/v1/latest?api_key=${encodeURIComponent(apiKey)}&currency=${encodeURIComponent(currency)}&unit=toz`,
      { headers: { Accept: 'application/json' } }
    );

    const price =
      parseFloat(d?.metals?.[metal]) ||
      parseFloat(d?.[metal]) ||
      parseFloat(d?.rates?.[metal]);

    if (price > 0) {
      return {
        symbol: id,
        type: 'metal',
        price,
        currency: String(d?.currency || currency || 'USD').toUpperCase(),
        change24h: 0,
        source: 'metals.dev/latest',
        lastUpdated: Date.now(),
      };
    }
  } catch (e) {
    console.warn('[metal] metals.dev latest:', e.message);
  }

  return null;
}

export default async function handler(req, res) {
  try {
    setCors(res);

    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const symbol = String(req.query.symbol || '').trim();
    const type = String(req.query.type || '').trim().toLowerCase();
    const cur = String(req.query.currency || 'USD').trim().toUpperCase();

    if (!symbol) return res.status(400).json({ error: 'symbol ist erforderlich' });
    if (!type) return res.status(400).json({ error: 'type ist erforderlich' });

    if (!['crypto', 'stock', 'etf', 'metal'].includes(type)) {
      return res.status(400).json({ error: 'type muss crypto|stock|etf|metal sein' });
    }

    let result = null;

    if (type === 'crypto') result = await cryptoQuote(symbol, cur);
    else if (type === 'metal') result = await metalQuote(symbol, cur);
    else result = await stockQuote(symbol, type, cur);

    if (!result) {
      return res.status(404).json({
        error: `Preis für ${symbol} nicht verfügbar`,
        code: 'NO_PRICE_RESULT',
      });
    }

    return res.status(200).json(result);
  } catch (e) {
    console.error('[api/quote] crash:', e);
    return res.status(500).json({
      error: e && e.message ? e.message : 'Server error',
      code: 'QUOTE_CRASH',
    });
  }
}
