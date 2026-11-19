import { randomBytes } from "node:crypto";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { formatUnits, parseUnits } from "viem";
import { type ActivityEntry, activityLogPath, isPaused, readActivity, setPaused } from "./activity.js";
import { ngtBalance, openBrowser } from "./fund.js";

const SHOWN_ENTRIES = 200;
const TOTALS_ENTRIES = 5000;
const MAX_WALLETS = 5;
const BALANCE_CACHE_MS = 15_000;
const HOUR_MS = 3_600_000;
const CHART_HOURS = 24;

export interface HourlySpend {
  /** Local hour start, ISO time. */
  start: string;
  amount: string;
}

export interface DashboardState {
  paused: boolean;
  activityLog: string;
  spentLastHour: string;
  spentToday: string;
  paidCallsToday: number;
  spendByHour: HourlySpend[];
  spentInChart: string;
  /** USDC totals, kept apart from NGT; null when the log holds no paid USDC call. */
  usdc: { spentLastHour: string; spentToday: string } | null;
  wallets: { address: string; balance: string | null }[];
  activity: ActivityEntry[];
}

type Asset = "NGT" | "USDC";
const DECIMALS: Record<Asset, number> = { NGT: 18, USDC: 6 };
const assetOf = (entry: ActivityEntry): Asset => (entry.asset === "USDC" ? "USDC" : "NGT");

/** Sums paid amounts in one token since `since`. Amounts are summed as integers so nothing is lost to rounding. */
export function spentSince(entries: ActivityEntry[], since: Date, asset: Asset = "NGT"): string {
  let total = 0n;
  for (const entry of entries) {
    if (entry.outcome !== "paid" || !entry.amount || assetOf(entry) !== asset || new Date(entry.time) < since) continue;
    try {
      total += parseUnits(entry.amount, DECIMALS[asset]);
    } catch {
      // A hand-edited amount is left out of the total.
    }
  }
  return formatUnits(total, DECIMALS[asset]);
}

/** Paid NGT per local hour for the last 24 hours, oldest first; the last hour is the current one so far. */
export function hourlySpend(entries: ActivityEntry[], now: Date): { hours: HourlySpend[]; total: string } {
  const currentHour = new Date(now);
  currentHour.setMinutes(0, 0, 0);
  const first = currentHour.getTime() - (CHART_HOURS - 1) * HOUR_MS;
  const totals = Array.from({ length: CHART_HOURS }, () => 0n);
  for (const entry of entries) {
    if (entry.outcome !== "paid" || !entry.amount || assetOf(entry) !== "NGT") continue;
    const at = new Date(entry.time).getTime();
    if (!(at >= first && at <= now.getTime())) continue;
    try {
      totals[Math.min(CHART_HOURS - 1, Math.floor((at - first) / HOUR_MS))] += parseUnits(entry.amount, 18);
    } catch {
      // A hand-edited amount is left out of the chart.
    }
  }
  return {
    hours: totals.map((amount, i) => ({ start: new Date(first + i * HOUR_MS).toISOString(), amount: formatUnits(amount, 18) })),
    total: formatUnits(totals.reduce((sum, amount) => sum + amount, 0n), 18),
  };
}

/** The page has no external resources, and writes log values as text, never as HTML. */
export function dashboardPage(nonce: string, token: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NGT Chain spending</title>
<style nonce="${nonce}">
  :root { --bg: #0b0e14; --card: #131722; --border: #2a2e39; --text: #e2e8f0; --muted: #94a3b8; --violet: #8a2be2; --mint: #00ffa3; --amber: #fbbf24; --red: #f87171; --stop: #dc2626; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 1.5rem; }
  main { max-width: 64rem; margin: 0 auto; }
  header { display: flex; align-items: center; justify-content: space-between; gap: .75rem; flex-wrap: wrap; margin-bottom: 1rem; }
  h1 { font-size: 1.25rem; margin: 0; }
  h2 { font-size: .9rem; font-weight: 600; color: var(--muted); margin: 0 0 .75rem; }
  .pill { font-size: .8rem; padding: .2rem .7rem; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); }
  .pill.active { color: var(--mint); border-color: var(--mint); }
  .pill.paused { color: var(--red); border-color: var(--red); }
  #toggle { width: 100%; padding: 1rem; border: 0; border-radius: 8px; color: #fff; font-size: 1rem; font-weight: 600; cursor: pointer; margin-bottom: 1.25rem; }
  #toggle.active { background: var(--violet); }
  #toggle.paused { background: var(--stop); }
  #toggle:disabled { opacity: .6; cursor: wait; }
  #toggle:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: 1rem; margin-bottom: 1rem; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; min-width: 0; margin-bottom: 1rem; }
  .grid .card { margin-bottom: 0; }
  .label { color: var(--muted); font-size: .8rem; }
  .address { font-family: ui-monospace, monospace; font-size: .75rem; color: var(--muted); overflow-wrap: anywhere; margin-top: .2rem; }
  .value { font-size: 1.25rem; font-family: ui-monospace, monospace; margin-top: .25rem; overflow-wrap: anywhere; }
  #chart svg { display: block; width: 100%; height: 6rem; }
  .bar { fill: var(--violet); }
  .bar.none { fill: var(--border); }
  .empty { color: var(--muted); font-size: .85rem; margin: 1.5rem 0; text-align: center; }
  .axis { display: flex; justify-content: space-between; gap: .5rem; color: var(--muted); font-size: .75rem; margin-top: .4rem; }
  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-family: ui-monospace, monospace; font-size: .8rem; }
  th, td { text-align: left; padding: .45rem .5rem; border-bottom: 1px solid var(--border); vertical-align: top; }
  td { overflow-wrap: anywhere; }
  td:not(:nth-child(3)) { white-space: nowrap; overflow-wrap: normal; }
  td:nth-child(3) { min-width: 14rem; }
  th { color: var(--muted); font-weight: 500; }
  .badge { display: inline-block; padding: .05rem .5rem; border-radius: 999px; background: var(--border); }
  .badge.paid { color: var(--mint); }
  .badge.refused, .badge.paused { color: var(--amber); }
  .badge.failed { color: var(--red); }
  .badge.free { color: var(--muted); }
  a { color: #c4b5fd; }
  footer { color: var(--muted); font-size: .8rem; }
  @media (max-width: 40rem) { body { padding: 1rem; } }
</style>
</head>
<body>
<main>
  <header>
    <h1>NGT Chain agent spending</h1>
    <span id="status" class="pill">Loading...</span>
  </header>
  <button id="toggle" type="button" class="active">Loading...</button>
  <div class="grid">
    <div class="card"><div class="label">Spent in the last hour</div><div class="value" id="hour">-</div></div>
    <div class="card"><div class="label">Spent today</div><div class="value" id="today">-</div></div>
    <div class="card"><div class="label">Paid calls today</div><div class="value" id="calls">-</div></div>
    <div class="card" id="usdcHourCard" hidden><div class="label">USDC spent in the last hour</div><div class="value" id="usdcHour">-</div></div>
    <div class="card" id="usdcTodayCard" hidden><div class="label">USDC spent today</div><div class="value" id="usdcToday">-</div></div>
  </div>
  <div class="grid" id="wallets"></div>
  <section class="card">
    <h2>Spend over the last 24 hours</h2>
    <div id="chart"></div>
    <div class="axis"><span>24 h ago</span><span id="chartTotal"></span><span>now</span></div>
  </section>
  <section class="card">
    <h2>Recent calls</h2>
    <div class="scroll">
    <table>
      <thead><tr><th>Time</th><th>App</th><th>Call</th><th>Outcome</th><th>Amount</th><th>Transaction</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
    </div>
  </section>
  <footer id="note"></footer>
</main>
<script nonce="${nonce}">
  const TOKEN = ${JSON.stringify(token)};
  const SVG_NS = "http://www.w3.org/2000/svg";
  const OUTCOMES = new Set(["paid", "free", "refused", "paused", "failed"]);
  const toggle = document.getElementById("toggle");
  let paused = false;

  function cell(text) {
    const td = document.createElement("td");
    td.textContent = text == null ? "" : String(text);
    return td;
  }

  function outcomeCell(outcome) {
    const td = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = OUTCOMES.has(outcome) ? "badge " + outcome : "badge";
    badge.textContent = outcome == null ? "" : String(outcome);
    td.append(badge);
    return td;
  }

  function drawChart(hours, total) {
    const box = document.getElementById("chart");
    const list = Array.isArray(hours) ? hours.slice(-24) : [];
    const amounts = list.map((h) => {
      const n = Number(h && h.amount);
      return Number.isFinite(n) && n > 0 ? n : 0;
    });
    const max = Math.max(0, ...amounts);
    document.getElementById("chartTotal").textContent = max > 0 ? "Total " + total + " NGT" : "";
    if (max === 0) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No paid calls in the last 24 hours";
      box.replaceChildren(empty);
      return;
    }
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 240 60");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "NGT paid per hour over the last 24 hours");
    list.forEach((h, i) => {
      const height = amounts[i] > 0 ? Math.max(2, (amounts[i] / max) * 58) : 1;
      const bar = document.createElementNS(SVG_NS, "rect");
      bar.setAttribute("x", String(i * 10 + 1));
      bar.setAttribute("y", String(60 - height));
      bar.setAttribute("width", "8");
      bar.setAttribute("height", String(height));
      bar.setAttribute("class", amounts[i] > 0 ? "bar" : "bar none");
      const title = document.createElementNS(SVG_NS, "title");
      const start = new Date(h && h.start);
      title.textContent = (isNaN(start) ? "" : start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + ": ") + String(h && h.amount) + " NGT";
      bar.append(title);
      svg.append(bar);
    });
    box.replaceChildren(svg);
  }

  function txCell(hash) {
    const td = document.createElement("td");
    if (typeof hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(hash)) {
      const a = document.createElement("a");
      a.href = "https://basescan.org/tx/" + hash;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = hash.slice(0, 10) + "...";
      td.append(a);
    }
    return td;
  }

  function render(state) {
    paused = state.paused === true;
    const status = document.getElementById("status");
    status.className = paused ? "pill paused" : "pill active";
    status.textContent = paused ? "Spending paused" : "Spending allowed";
    toggle.className = paused ? "paused" : "active";
    toggle.textContent = paused ? "Spending paused. Click to resume" : "Agents may spend. Click to pause";
    document.getElementById("hour").textContent = state.spentLastHour + " NGT";
    document.getElementById("today").textContent = state.spentToday + " NGT";
    document.getElementById("calls").textContent = String(state.paidCallsToday);
    const usdc = state.usdc && typeof state.usdc === "object" ? state.usdc : null;
    document.getElementById("usdcHourCard").hidden = !usdc;
    document.getElementById("usdcTodayCard").hidden = !usdc;
    if (usdc) {
      document.getElementById("usdcHour").textContent = usdc.spentLastHour + " USDC";
      document.getElementById("usdcToday").textContent = usdc.spentToday + " USDC";
    }
    drawChart(state.spendByHour, state.spentInChart);

    const wallets = document.getElementById("wallets");
    wallets.replaceChildren(...state.wallets.map((w) => {
      const card = document.createElement("div");
      card.className = "card";
      const label = document.createElement("div");
      label.className = "label";
      label.textContent = "Agent wallet";
      const address = document.createElement("div");
      address.className = "address";
      address.textContent = w.address;
      const value = document.createElement("div");
      value.className = "value";
      value.textContent = w.balance === null ? "balance unavailable" : w.balance + " NGT";
      card.append(label, address, value);
      return card;
    }));

    const rows = document.getElementById("rows");
    rows.replaceChildren(...state.activity.map((e) => {
      const tr = document.createElement("tr");
      const call = (e.host ? e.host + (e.path || "") : e.tool) + (e.reason ? " (" + e.reason + ")" : "");
      tr.append(
        cell(new Date(e.time).toLocaleString()),
        cell(e.app),
        cell(call),
        outcomeCell(e.outcome),
        cell(e.amount ? e.amount + (e.asset === "USDC" ? " USDC" : " NGT") : ""),
        txCell(e.transaction),
      );
      return tr;
    }));
    document.getElementById("note").textContent = (state.activity.length === 0
      ? "No paid calls logged yet. Log file: "
      : "Newest first. Refreshes every 4 seconds. Only reachable from this computer. Log file: ") + state.activityLog;
  }

  async function refresh() {
    try {
      const res = await fetch("/api/state", { headers: { "x-ngt-token": TOKEN } });
      if (res.ok) render(await res.json());
    } catch {
      document.getElementById("note").textContent = "The dashboard server has stopped. Run npx -y @ngtchain/mcp@1.7.2 dashboard again.";
    }
  }

  toggle.addEventListener("click", async () => {
    toggle.disabled = true;
    try {
      await fetch(paused ? "/api/resume" : "/api/pause", { method: "POST", headers: { "x-ngt-token": TOKEN } });
      await refresh();
    } finally {
      toggle.disabled = false;
    }
  });

  refresh();
  setInterval(refresh, 4000);
</script>
</body>
</html>
`;
}

export interface DashboardOptions {
  /** Reads an NGT balance; tests pass a stub so no RPC is called. */
  balanceOf?: (address: `0x${string}`) => Promise<bigint>;
}

/** Serves the dashboard on 127.0.0.1 at a free port. */
export async function startDashboard(options: DashboardOptions = {}): Promise<{ url: string; close: () => void }> {
  const balanceOf = options.balanceOf ?? ngtBalance;
  const nonce = randomBytes(16).toString("base64");
  const token = randomBytes(24).toString("hex");
  const page = dashboardPage(nonce, token);
  const balances = new Map<string, { at: number; value: string | null }>();
  let port = 0;

  async function walletBalance(address: string): Promise<string | null> {
    const cached = balances.get(address);
    if (cached && Date.now() - cached.at < BALANCE_CACHE_MS) return cached.value;
    let value: string | null = null;
    try {
      value = formatUnits(await balanceOf(address as `0x${string}`), 18);
    } catch {
      // Shown as unavailable; the next refresh tries again.
    }
    balances.set(address, { at: Date.now(), value });
    return value;
  }

  async function state(): Promise<DashboardState> {
    const all = readActivity(TOTALS_ENTRIES);
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const addresses = [...new Set(all.map((e) => e.wallet).filter((w): w is string => /^0x[0-9a-fA-F]{40}$/.test(w ?? "")))];
    const chart = hourlySpend(all, now);
    return {
      paused: isPaused(),
      activityLog: activityLogPath(),
      spentLastHour: spentSince(all, new Date(now.getTime() - HOUR_MS)),
      spentToday: spentSince(all, midnight),
      paidCallsToday: all.filter((e) => e.outcome === "paid" && new Date(e.time) >= midnight).length,
      spendByHour: chart.hours,
      spentInChart: chart.total,
      usdc: all.some((e) => e.outcome === "paid" && assetOf(e) === "USDC")
        ? { spentLastHour: spentSince(all, new Date(now.getTime() - HOUR_MS), "USDC"), spentToday: spentSince(all, midnight, "USDC") }
        : null,
      wallets: await Promise.all(addresses.slice(0, MAX_WALLETS).map(async (address) => ({ address, balance: await walletBalance(address) }))),
      activity: all.slice(0, SHOWN_ENTRIES),
    };
  }

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(body));
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // A different Host means another site resolved its name to this machine (DNS rebinding).
    if (req.headers.host !== `127.0.0.1:${port}`) return void res.writeHead(403).end();

    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      return void res.end(page);
    }

    const isApi = req.url === "/api/state" || req.url === "/api/pause" || req.url === "/api/resume";
    if (!isApi) return void res.writeHead(404).end();
    if (req.headers["x-ngt-token"] !== token) return json(res, 403, { error: "missing or wrong token" });

    if (req.method === "GET" && req.url === "/api/state") return json(res, 200, await state());
    if (req.method === "POST" && (req.url === "/api/pause" || req.url === "/api/resume")) {
      if (req.headers.origin !== `http://127.0.0.1:${port}`) return json(res, 403, { error: "wrong origin" });
      setPaused(req.url === "/api/pause");
      return json(res, 200, { paused: isPaused() });
    }
    return void res.writeHead(404).end();
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/`, close: () => server.close() };
}

/** `npx @ngtchain/mcp dashboard`: serves until Ctrl+C. */
export async function runDashboard(): Promise<void> {
  const dashboard = await startDashboard();
  console.log(`NGT Chain dashboard: ${dashboard.url}`);
  console.log("It only listens on this computer. Press Ctrl+C to stop it.");
  openBrowser(dashboard.url);
  await new Promise<void>((resolve) => process.once("SIGINT", resolve));
  dashboard.close();
}
