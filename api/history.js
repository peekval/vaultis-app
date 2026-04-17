export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")
    return res.status(200).end()
  }

  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")

  const { symbol, type, range } = req.query

  try {
    // CRYPTO
    if (type === "crypto") {
      const daysMap = {
        "7D": 7,
        "1M": 30,
        "6M": 180,
        "1Y": 365
      }

      const days = daysMap[range] || 30

      const r = await fetch(
        `https://api.coingecko.com/api/v3/coins/${symbol}/market_chart?vs_currency=chf&days=${days}`
      )
      const data = await r.json()

      const points = data.prices.map(p => ({
        date: new Date(p[0]).toISOString().split("T")[0],
        price: p[1]
      }))

      return res.status(200).json({
        symbol,
        type,
        range,
        source: "coingecko",
        points
      })
    }

    // STOCK
    if (type === "stock") {
      const r = await fetch(
        `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${symbol}&apikey=${process.env.ALPHA_VANTAGE_API_KEY}`
      )

      const data = await r.json()
      const series = data["Time Series (Daily)"]

      if (!series) {
        return res.status(404).json({ error: "No data" })
      }

      const points = Object.entries(series)
        .slice(0, 200)
        .map(([date, value]) => ({
          date,
          price: parseFloat(value["4. close"])
        }))
        .reverse()

      return res.status(200).json({
        symbol,
        type,
        range,
        source: "alphavantage",
        points
      })
    }

    return res.status(400).json({ error: "Invalid type" })

  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
