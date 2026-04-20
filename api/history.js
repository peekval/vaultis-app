// ===============================
// STORAGE KEY
// ===============================
const STORAGE_KEY = "portfolio_positions";

// ===============================
// LOAD POSITIONS
// ===============================
function loadPositions() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

// ===============================
// SAVE POSITIONS
// ===============================
function savePositions(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

// ===============================
// CALCULATE CURRENT VALUE
// ===============================
async function updatePortfolio() {
  const positions = loadPositions();

  let totalValue = 0;
  let totalInvested = 0;

  for (let pos of positions) {
    const price = await window.getLivePrice(pos.symbol, pos.type);

    if (!price) {
      console.warn("No price for:", pos.symbol);
      continue;
    }

    const currentValue = price * pos.amount;

    pos.currentPrice = price;
    pos.currentValue = currentValue;

    totalValue += currentValue;
    totalInvested += pos.invested;
  }

  renderPortfolio(positions, totalValue, totalInvested);
}

// ===============================
// RENDER UI
// ===============================
function renderPortfolio(positions, totalValue, totalInvested) {
  const container = document.getElementById("portfolio-list");
  const summary = document.getElementById("portfolio-summary");

  if (!container || !summary) return;

  container.innerHTML = "";

  positions.forEach(pos => {
    const profit = pos.currentValue - pos.invested;
    const percent = (profit / pos.invested) * 100;

    const el = document.createElement("div");
    el.className = "position";

    el.innerHTML = `
      <div class="row">
        <strong>${pos.symbol}</strong> (${pos.type})
      </div>
      <div class="row">
        Investiert: CHF ${pos.invested.toFixed(2)}
      </div>
      <div class="row">
        Aktuell: CHF ${pos.currentValue.toFixed(2)}
      </div>
      <div class="row ${profit >= 0 ? "green" : "red"}">
        ${profit >= 0 ? "+" : ""}${profit.toFixed(2)} CHF (${percent.toFixed(2)}%)
      </div>
    `;

    container.appendChild(el);
  });

  const totalProfit = totalValue - totalInvested;
  const totalPercent = (totalProfit / totalInvested) * 100;

  summary.innerHTML = `
    <div><strong>Gesamtwert:</strong> CHF ${totalValue.toFixed(2)}</div>
    <div><strong>Investiert:</strong> CHF ${totalInvested.toFixed(2)}</div>
    <div class="${totalProfit >= 0 ? "green" : "red"}">
      <strong>Gewinn:</strong> ${totalProfit >= 0 ? "+" : ""}${totalProfit.toFixed(2)} CHF (${totalPercent.toFixed(2)}%)
    </div>
  `;
}

// ===============================
// AUTO REFRESH
// ===============================
async function initPortfolio() {
  await updatePortfolio();

  // alle 60 Sekunden aktualisieren
  setInterval(updatePortfolio, 60000);
}

// ===============================
// START
// ===============================
document.addEventListener("DOMContentLoaded", initPortfolio);
