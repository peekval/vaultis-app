export default async function handler(req, res) {
  const { symbol, type } = req.query

  try {
    if (type === "crypto") {
      const r = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${symbol}&vs_currencies=chf`
      )
      const data = await r.json()

      return res.status(200).json({
        price: data[symbol]?.chf || null,
        source: "coingecko"
      })
    }

    if (type === "stock") {
      const r = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${process.env.FINNHUB_API_KEY}`
      )
      const data = await r.json()

      return res.status(200).json({
        price: data.c ?? null,
        change: data.d ?? null,
        percent: data.dp ?? null,
        source: "finnhub"
      })
    }

    return res.status(400).json({ error: "unknown type" })
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Unknown error"
    })
  }
}
