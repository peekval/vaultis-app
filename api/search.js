// api/search.js
// GET /api/search?q=apple&type=stock
// type: crypto | stock | etf | metal (optional, default: alle)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── Static ETF Catalog ────────────────────────────────────────
const ETF_CATALOG = [
  { symbol: 'VWRL',  name: 'Vanguard FTSE All-World ETF',        exchange: 'LSE',    isin: 'IE00B3RBWM25', ter: '0.22%', dist: 'Ausschüttend' },
  { symbol: 'VWCE',  name: 'Vanguard FTSE All-World ETF (Acc)',   exchange: 'XETRA',  isin: 'IE00BK5BQT80', ter: '0.22%', dist: 'Thesaurierend' },
  { symbol: 'IWDA',  name: 'iShares Core MSCI World ETF',         exchange: 'AMS',    isin: 'IE00B4L5Y983', ter: '0.20%', dist: 'Thesaurierend' },
  { symbol: 'CSPX',  name: 'iShares Core S&P 500 ETF',            exchange: 'LSE',    isin: 'IE00B5BMR087', ter: '0.07%', dist: 'Thesaurierend' },
  { symbol: 'EQQQ',  name: 'Invesco NASDAQ-100 ETF',              exchange: 'LSE',    isin: 'IE0032077012', ter: '0.30%', dist: 'Thesaurierend' },
  { symbol: 'VUSA',  name: 'Vanguard S&P 500 ETF',                exchange: 'LSE',    isin: 'IE00B3XXRP09', ter: '0.07%', dist: 'Ausschüttend' },
  { symbol: 'XDWD',  name: 'Xtrackers MSCI World Swap ETF',       exchange: 'XETRA',  isin: 'IE00BJ0KDQ92', ter: '0.19%', dist: 'Thesaurierend' },
  { symbol: 'SSAC',  name: 'iShares MSCI ACWI ETF',               exchange: 'LSE',    isin: 'IE00B6R52259', ter: '0.20%', dist: 'Thesaurierend' },
  { symbol: 'SMEA',  name: 'iShares STOXX Europe 600 ETF',        exchange: 'XETRA',  isin: 'IE00B3ZW0K18', ter: '0.20%', dist: 'Thesaurierend' },
  { symbol: 'QQQ',   name: 'Invesco QQQ Trust (NASDAQ-100)',       exchange: 'NASDAQ', isin: 'US46090E1038', ter: '0.20%', dist: 'Ausschüttend' },
  { symbol: 'SPY',   name: 'SPDR S&P 500 ETF Trust',              exchange: 'NYSE',   isin: 'US78462F1030', ter: '0.09%', dist: 'Ausschüttend' },
  { symbol: 'VTI',   name: 'Vanguard Total Stock Market ETF',      exchange: 'NYSE',   isin: 'US9229087690', ter: '0.03%', dist: 'Ausschüttend' },
  { symbol: 'URTH',  name: 'iShares MSCI World ETF (USD)',         exchange: 'NYSE',   isin: 'US46432F3733', ter: '0.24%', dist: 'Ausschüttend' },
  { symbol: 'XLK',   name: 'Technology Select Sector SPDR',        exchange: 'NYSE',   isin: 'US81369Y8030', ter: '0.09%', dist: 'Ausschüttend' },
  { symbol: 'ARKK',  name: 'ARK Innovation ETF',                   exchange: 'NYSE',   isin: 'US00214Q1040', ter: '0.75%', dist: 'Thesaurierend' },
];

// ── Static Metal Catalog ──────────────────────────────────────
const METAL_CATALOG = [
  { symbol: 'gold',      name: 'Gold',      description: 'Edelmetall · USD/oz Spotpreis' },
  { symbol: 'silver',    name: 'Silber',    description: 'Edelmetall · USD/oz Spotpreis' },
  { symbol: 'platinum',  name: 'Platin',    description: 'Edelmetall · USD/oz Spotpreis' },
  { symbol: 'palladium', name: 'Palladium', description: 'Edelmetall · USD/oz Spotpreis' },
];

// Robust fetch mit Promise.race Timeout
async function fetchWithTimeout(url, opts = {}, timeoutMs = 6000) {
  return Promise.race([
    fetch(url, opts),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`Timeout ${timeoutMs}ms`)), timeoutMs))
  ]);
}

// ── CoinGecko Crypto Search ───────────────────────────────────
async function searchCrypto(q) {
  const key = process.env.COINGECKO_API_KEY;
  const url = `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(q)}`;
  const r = await fetchWithTimeout(url, {
    headers: key ? { 'x-cg-demo-api-key': key } : {},
  }, 6000);
  if (!r.ok) throw new Error(`CoinGecko search HTTP ${r.status}`);
  const d = await r.json();
  const coins = Array.isArray(d.coins) ? d.coins : [];
  return coins.slice(0, 15).map(c => ({
    symbol: c.id,
    ticker: c.symbol?.toUpperCase(),
    name:   c.name,
    type:   'crypto',
    thumb:  c.thumb || null,
  }));
}

// ── Finnhub Stock+ETF Search ──────────────────────────────────
async function searchStocks(q, typeFilter) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return [];
  const url = `https://finnhub.io/api/v1/search?q=${encodeURIComponent(q)}&token=${key}`;
  const r = await fetchWithTimeout(url, {}, 6000);
  if (!r.ok) throw new Error(`Finnhub search HTTP ${r.status}`);
  const d = await r.json();
  const results = Array.isArray(d.result) ? d.result : [];
  return results
    .slice(0, 20)
    .map(x => {
      // Finnhub type: 'ETP' = ETF, 'Common Stock' = stock
      const assetType = x.type === 'ETP' ? 'etf' : 'stock';
      return {
        symbol:   x.symbol,
        ticker:   x.displaySymbol || x.symbol,
        name:     x.description,
        type:     assetType,
        exchange: x.displaySymbol?.includes('.') ? x.displaySymbol.split('.').pop() : undefined,
      };
    })
    .filter(x => {
      if (!typeFilter || typeFilter === 'all') return true;
      return x.type === typeFilter;
    });
}

// ── Static ETF Search ─────────────────────────────────────────
function searchEtfsStatic(q) {
  const ql = q.toLowerCase();
  return ETF_CATALOG
    .filter(e => e.symbol.toLowerCase().includes(ql) || e.name.toLowerCase().includes(ql) || (e.isin && e.isin.toLowerCase().includes(ql)))
    .map(e => ({
      symbol:   e.symbol,
      ticker:   e.symbol,
      name:     e.name,
      type:     'etf',
      exchange: e.exchange,
      isin:     e.isin,
      ter:      e.ter,
      dist:     e.dist,
    }));
}

// ── Static Metal Search ───────────────────────────────────────
function searchMetalsStatic(q) {
  const ql = q.toLowerCase();
  return METAL_CATALOG
    .filter(m => m.symbol.toLowerCase().includes(ql) || m.name.toLowerCase().includes(ql))
    .map(m => ({
      symbol:      m.symbol,
      ticker:      m.symbol.toUpperCase(),
      name:        m.name,
      type:        'metal',
      description: m.description,
    }));
}

// ── HANDLER ──────────────────────────────────────────────────
export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { q = '', type = 'all' } = req.query;
  const query = q.trim();

  if (query.length < 1) {
    return res.status(400).json({ error: 'q ist erforderlich' });
  }

  const wantsCrypto = type === 'all' || type === 'crypto';
  const wantsStock  = type === 'all' || type === 'stock';
  const wantsEtf    = type === 'all' || type === 'etf';
  const wantsMetal  = type === 'all' || type === 'metal';

  const tasks = [];
  if (wantsCrypto) tasks.push(searchCrypto(query).catch(e => { console.warn('[search] crypto:', e.message); return []; }));
  if (wantsStock || wantsEtf) tasks.push(searchStocks(query, wantsStock && !wantsEtf ? 'stock' : wantsEtf && !wantsStock ? 'etf' : null).catch(e => { console.warn('[search] stocks:', e.message); return []; }));
  if (wantsEtf)   tasks.push(Promise.resolve(searchEtfsStatic(query)));
  if (wantsMetal) tasks.push(Promise.resolve(searchMetalsStatic(query)));

  const results = await Promise.all(tasks);
  let hits = results.flat();

  // Deduplicate by type:symbol
  const seen = new Set();
  hits = hits.filter(h => {
    const k = `${h.type}:${h.symbol}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return res.status(200).json({ hits: hits.slice(0, 50) });
}
