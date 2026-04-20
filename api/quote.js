// ===============================
// CONFIG
// ===============================
const FINNHUB_API_KEY = "DEIN_FINNHUB_API_KEY"; // https://finnhub.io
const METAL_API = "https://api.metals.live/v1/spot";

// ===============================
// PUBLIC FUNCTION (GLOBAL)
// ===============================
window.getLivePrice = async function(symbol, type) {
  try {
    if (type === "crypto") return await getCrypto(symbol);
    if (type === "metal") return await getMetal(symbol);
    return await getStock(symbol);
  } catch (e) {
    console.error("Final error:", e);
    return null;
  }
};

// ===============================
// STOCKS (Finnhub -> Yahoo fallback)
// ===============================
async function getStock(symbol) {
  try {
    const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_API_KEY}`);
    const data = await res.json();

    if (data && data.c && data.c !== 0) {
      return data.c;
    }

    throw "Finnhub failed";
  } catch {
    return await getYahoo(symbol);
  }
}

// ===============================
// YAHOO FALLBACK (FREE)
// ===============================
async function getYahoo(symbol) {
  try {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`);
    const data = await res.json();

    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return price || null;
  } catch (e) {
    console.error("Yahoo failed:", e);
    return null;
  }
}

// ===============================
// CRYPTO (CoinGecko FREE)
// ===============================
async function getCrypto(symbol) {
  try {
    const map = {
      BTC: "bitcoin",
      ETH: "ethereum",
      SOL: "solana"
    };

    const id = map[symbol.toUpperCase()];
    if (!id) return null;

    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=chf`);
    const data = await res.json();

    return data?.[id]?.chf || null;
  } catch (e) {
    console.error("Crypto error:", e);
    return null;
  }
}

// ===============================
// METALS (FREE)
// ===============================
async function getMetal(symbol) {
  try {
    const res = await fetch(METAL_API);
    const data = await res.json();

    const map = {
      gold: "gold",
      silver: "silver",
      platinum: "platinum"
    };

    const metal = map[symbol.toLowerCase()];
    if (!metal) return null;

    const found = data.find(x => Object.keys(x)[0] === metal);
    return found?.[metal] || null;
  } catch (e) {
    console.error("Metal error:", e);
    return null;
  }
}
