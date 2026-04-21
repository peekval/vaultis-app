// api/quote.js
// GET /api/quote?symbol=AAPL&type=stock&currency=CHF

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── FX: USD → target ─────────────────────────────────────────
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

// ── CRYPTO — Binance primary, CoinGecko fallback ─────────────
const BINANCE_SYMBOL = {
  bitcoin:'BTCUSDT', ethereum:'ETHUSDT', solana:'SOLUSDT',
  ripple:'XRPUSDT', binancecoin:'BNBUSDT', cardano:'ADAUSDT',
  'avalanche-2':'AVAXUSDT', chainlink:'LINKUSDT', polkadot:'DOTUSDT',
  litecoin:'LTCUSDT', dogecoin:'DOGEUSDT',
  'the-open-network':'TONUSDT', tron:'TRXUSDT', aptos:'APTUSDT',
  sui:'SUIUSDT', near:'NEARUSDT', arbitrum:'ARBUSDT',
  uniswap:'UNIUSDT', aave:'AAVEUSDT',
  pepe:'PEPEUSDT', 'shiba-inu':'SHIBUSDT',
  stellar:'XLMUSDT', cosmos:'ATOMUSDT',
  'ethereum-classic':'ETCUSDT', filecoin:'FILUSDT',
  'internet-computer':'ICPUSDT', 'render-token':'RNDRUSDT',
  'injective-protocol':'INJUSDT', optimism:'OPUSDT',
  maker:'MKRUSDT', stacks:'STXUSDT',
  'hedera-hashgraph':'HBARUSDT', algorand:'ALGOUSDT',
  'the-graph':'GRTUSDT', 'immutable-x':'IMXUSDT',
  vechain:'VETUSDT', 'fetch-ai':'FETUSDT',
  'jupiter-exchange-solana':'JUPUSDT', 'worldcoin-wld':'WLDUSDT',
  'sei-network':'SEIUSDT',
  // monero ist auf Binance delisted → bleibt auf CoinGecko fallback
};

async function cryptoQuote(id, currency) {
  const binSym = BINANCE_SYMBOL[id.toLowerCase()];

  // Binance primary
  if (binSym) {
    try {
      const r = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${binSym}`,
        { signal: AbortSignal.timeout(6000) });
      if (r.ok) {
        const d = await r.json();
        const priceUsd = parseFloat(d.lastPrice);
        const chg = parseFloat(d.priceChangePercent);
        if (priceUsd > 0) {
          const rate = await usdRate(currency);
          return {
            symbol: id, type: 'crypto',
            price: priceUsd * rate, currency,
            change24h: isNaN(chg) ? 0 : chg,
            source: 'binance:' + binSym,
            lastUpdated: Date.now(),
          };
        }
      }
    } catch (e) { console.warn('[crypto] binance:', e.message); }
  }

  // CoinGecko fallback
  try {
    const cur = currency.toLowerCase();
    const key = process.env.COINGECKO_API_KEY;
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=${cur},usd&include_24hr_change=true`,
      { headers: key ? { 'x-cg-demo-api-key': key } : {}, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const d = await r.json();
    const entry = d[id];
    if (!entry) return null;
    const price = entry[cur] ?? entry.usd;
    if (typeof price !== 'number' || price <= 0) return null;
    return {
      symbol: id, type: 'crypto',
      price, currency,
      change24h: entry[`${cur}_24h_change`] ?? entry.usd_24h_change ?? 0,
      source: 'coingecko', lastUpdated: Date.now(),
    };
  } catch (e) {
    console.warn('[crypto] coingecko:', e.message);
    return null;
  }
}

// ── STOCK — Finnhub primary, Twelve Data fallback ────────────
async function stockQuote(symbol, type) {
  const finnKey = process.env.FINNHUB_API_KEY;
  if (finnKey) {
    try {
      const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${finnKey}`,
        { signal: AbortSignal.timeout(6000) });
      if (r.ok) {
        const d = await r.json();
        if (typeof d.c === 'number' && d.c > 0) {
          return {
            symbol, type,
            price: d.c, currency: 'USD',
            change24h: typeof d.dp === 'number' ? d.dp : 0,
            source: 'finnhub',
            lastUpdated: (d.t || Date.now()/1000) * 1000,
          };
        }
      }
    } catch (e) { console.warn('[stock] finnhub:', e.message); }
  }

  const tdKey = process.env.TWELVE_DATA_API_KEY;
  if (tdKey) {
    try {
      const r = await fetch(`https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}&apikey=${tdKey}`,
        { signal: AbortSignal.timeout(6000) });
      if (r.ok) {
        const d = await r.json();
        if (d.status !== 'error' && d.close) {
          const price = parseFloat(d.close);
          const chg = parseFloat(d.percent_change);
          if (price > 0) {
            return {
              symbol, type,
              price, currency: d.currency || 'USD',
              change24h: isNaN(chg) ? 0 : chg,
              source: 'twelvedata', lastUpdated: Date.now(),
            };
          }
        }
      }
    } catch (e) { console.warn('[stock] twelvedata:', e.message); }
  }

  return null;
}

// ── METAL — metals.live (free, no key) ───────────────────────
const METAL_KEY = {
  gold: 'gold', silver: 'silver',
  platinum: 'platinum', palladium: 'palladium',
};

async function metalQuote(id, currency) {
  const key = METAL_KEY[id.toLowerCase()];
  if (!key) return null;

  try {
    const r = await fetch('https://api.metals.live/v1/spot',
      { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const data = await r.json();
    if (!Array.isArray(data)) return null;

    const spot = {};
    data.forEach(obj => Object.assign(spot, obj));
    const priceUsd = spot[key];
    if (typeof priceUsd !== 'number' || priceUsd <= 0) return null;

    const rate = await usdRate(currency);
    return {
      symbol: id, type: 'metal',
      price: priceUsd * rate, currency,
      change24h: 0,  // metals.live liefert keinen 24h-change
      source: 'metals.live',
      lastUpdated: Date.now(),
    };
  } catch (e) {
    console.warn('[metal] metals.live:', e.message);
    return null;
  }
}

// ── HANDLER ──────────────────────────────────────────────────
export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k,v]) => res.setHeader(k,v));

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { symbol, type, currency = 'USD' } = req.query;
  const cur = currency.toUpperCase();

  if (!symbol) return res.status(400).json({ error: 'symbol ist erforderlich' });
  if (!type)   return res.status(400).json({ error: 'type ist erforderlich' });
  if (!['crypto','stock','etf','metal'].includes(type)) {
    return res.status(400).json({ error: `type muss crypto|stock|etf|metal sein` });
  }

  try {
    let result = null;
    if (type === 'crypto') result = await cryptoQuote(symbol, cur);
    else if (type === 'metal') result = await metalQuote(symbol, cur);
    else /* stock | etf */ result = await stockQuote(symbol, type);

    if (!result) {
      return res.status(404).json({ error: `Preis für ${symbol} nicht verfügbar` });
    }
    return res.status(200).json(result);
  } catch (e) {
    console.error('[api/quote]', e);
    return res.status(500).json({ error: `Interner Fehler: ${e.message}` });
  }
}
