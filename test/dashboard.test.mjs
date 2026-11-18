// The local dashboard: 127.0.0.1 only, a strict CSP, and pause/resume only with the page token, its own Origin
// and its own Host, so another website (or a DNS-rebound name) cannot read the log or flip the switch.
import "./isolate.mjs";
import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import { isPaused, recordActivity, setPaused } from "../dist/activity.js";
import { hourlySpend, spentSince, startDashboard } from "../dist/dashboard.js";

const WALLET = "0x2222222222222222222222222222222222222222";
const TX = `0x${"cd".repeat(32)}`;

/** Raw HTTP so the test can send the Host and Origin headers a browser on another site would. */
function send(url, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function withDashboard(run) {
  const balanceCalls = [];
  const dashboard = await startDashboard({ balanceOf: async (address) => (balanceCalls.push(address), 1_500_000_000_000_000_000n) });
  const host = new URL(dashboard.url).host;
  const page = await send(dashboard.url);
  const token = /const TOKEN = "([0-9a-f]+)"/.exec(page.body)?.[1];
  try {
    await run({ url: dashboard.url, host, origin: `http://${host}`, page, token, balanceCalls });
  } finally {
    dashboard.close();
  }
}

test("listens on 127.0.0.1 and serves a page with a strict CSP and no external resources", async () => {
  await withDashboard(async ({ url, page, token }) => {
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(page.status, 200);
    const csp = page.headers["content-security-policy"];
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'nonce-[^']+'/);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /https?:|\*|unsafe-inline|unsafe-eval/);
    assert.equal(page.headers["cache-control"], "no-store");
    assert.equal(page.headers["x-content-type-options"], "nosniff");
    assert.doesNotMatch(page.body, /<(script|link|img|iframe)[^>]*(src|href)=/i, "nothing is loaded from elsewhere");
    assert.doesNotMatch(page.body, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, "log values are written as text");
    assert.doesNotMatch(page.body, /\son[a-z]+\s*=|\.on[a-z]+\s*=/i, "no inline or property event handlers");
    assert.doesNotMatch(page.body, /\sstyle\s*=/i, "no style attributes; styles live in the nonce'd block");
    const urls = page.body.match(/https?:\/\/[^\s"'`]+/g) ?? [];
    assert.deepEqual([...new Set(urls)].sort(), ["http://www.w3.org/2000/svg", "https://basescan.org/tx/"], "only the SVG namespace and Basescan links");
    assert.equal((page.body.match(/<style nonce=/g) ?? []).length, 1);
    assert.equal((page.body.match(/<script nonce=/g) ?? []).length, 1);
    assert.match(page.body, /\/\^0x\[0-9a-fA-F\]\{64\}\$\/\.test\(hash\)/, "only a 64-hex hash becomes a link");
    assert.match(token, /^[0-9a-f]{48}$/);
  });
});

test("state needs the token and reports the log, totals and stubbed balances", async () => {
  setPaused(false);
  recordActivity({ app: "Cursor", tool: "pay_and_fetch", host: "api.example.com", path: "/quote", outcome: "paid", amount: "0.002", transaction: TX, wallet: WALLET });
  recordActivity({ app: "Cursor", tool: "pay_and_fetch", host: "api.example.com", path: "/quote", outcome: "paid", amount: "0.0005", wallet: WALLET });
  recordActivity({ app: "Cursor", tool: "pay_and_fetch", host: "api.example.com", path: "/x", outcome: "refused", reason: "over cap" });
  await withDashboard(async ({ url, host, token, balanceCalls }) => {
    assert.equal((await send(`${url}api/state`)).status, 403, "no token");
    assert.equal((await send(`${url}api/state`, { headers: { "x-ngt-token": "0".repeat(48) } })).status, 403, "wrong token");
    assert.equal((await send(`${url}api/state`, { headers: { "x-ngt-token": token, host: `evil.example:${host.split(":")[1]}` } })).status, 403, "foreign Host");

    const res = await send(`${url}api/state`, { headers: { "x-ngt-token": token } });
    assert.equal(res.status, 200);
    assert.equal(res.headers["cache-control"], "no-store");
    const state = JSON.parse(res.body);
    assert.equal(state.paused, false);
    assert.equal(state.spentLastHour, "0.0025");
    assert.equal(state.spentToday, "0.0025");
    assert.equal(state.paidCallsToday, 2);
    assert.equal(state.spendByHour.length, 24);
    assert.equal(state.spentInChart, "0.0025");
    assert.deepEqual(state.wallets, [{ address: WALLET, balance: "1.5" }]);
    assert.deepEqual(state.activity.map((e) => e.outcome), ["refused", "paid", "paid"]);
    assert.match(state.activityLog, /activity\.jsonl$/);

    await send(`${url}api/state`, { headers: { "x-ngt-token": token } });
    assert.equal(balanceCalls.length, 1, "balances are cached between refreshes");
  });
});

test("pause and resume need the token, the page's Origin and the page's Host", async () => {
  setPaused(false);
  await withDashboard(async ({ url, host, origin, token }) => {
    const pause = (headers) => send(`${url}api/pause`, { method: "POST", headers });
    assert.equal((await pause({ origin })).status, 403, "no token");
    assert.equal((await pause({ "x-ngt-token": token })).status, 403, "no Origin");
    assert.equal((await pause({ "x-ngt-token": token, origin: "https://evil.example" })).status, 403, "foreign Origin");
    assert.equal((await pause({ "x-ngt-token": token, origin: "http://localhost:" + host.split(":")[1] })).status, 403, "localhost alias");
    assert.equal((await pause({ "x-ngt-token": token, origin, host: "evil.example" })).status, 403, "foreign Host");
    assert.equal(isPaused(), false, "no rejected request changed the flag");

    const paused = await pause({ "x-ngt-token": token, origin });
    assert.equal(paused.status, 200);
    assert.deepEqual(JSON.parse(paused.body), { paused: true });
    assert.equal(isPaused(), true);

    assert.equal((await send(`${url}api/pause`, { headers: { "x-ngt-token": token, origin } })).status, 404, "GET cannot pause");
    const resumed = await send(`${url}api/resume`, { method: "POST", headers: { "x-ngt-token": token, origin } });
    assert.deepEqual(JSON.parse(resumed.body), { paused: false });
    assert.equal(isPaused(), false);
  });
});

test("other paths and a foreign Host on the page are refused", async () => {
  await withDashboard(async ({ url, host, token }) => {
    for (const path of ["favicon.ico", "api", "api/state/", "activity.jsonl", "..%2Factivity.jsonl"]) {
      assert.equal((await send(`${url}${path}`, { headers: { "x-ngt-token": token } })).status, 404, path);
    }
    assert.equal((await send(url, { headers: { host: `attacker.example:${host.split(":")[1]}` } })).status, 403);
  });
});

test("spentSince sums paid amounts exactly and ignores old, unpaid and malformed entries", () => {
  const now = Date.now();
  const at = (msAgo) => new Date(now - msAgo).toISOString();
  const entries = [
    { time: at(1000), outcome: "paid", amount: "0.1" },
    { time: at(2000), outcome: "paid", amount: "0.2" },
    { time: at(3000), outcome: "free" },
    { time: at(4000), outcome: "refused", amount: "5" },
    { time: at(5000), outcome: "paid", amount: "not a number" },
    { time: at(7_200_000), outcome: "paid", amount: "9" },
  ];
  assert.equal(spentSince(entries, new Date(now - 3_600_000)), "0.3", "no floating-point drift");
  assert.equal(spentSince([], new Date(0)), "0");
});

test("hourlySpend buckets paid amounts exactly into the last 24 local hours, current hour last", () => {
  const now = new Date(2026, 10, 12, 14, 20, 0);
  const at = (hour, minute) => new Date(2026, 10, 12, hour, minute).toISOString();
  const entries = [
    { time: at(14, 5), outcome: "paid", amount: "0.1" },
    { time: at(14, 10), outcome: "paid", amount: "0.2" },
    { time: at(13, 59), outcome: "paid", amount: "0.001" },
    { time: new Date(2026, 10, 11, 15, 0).toISOString(), outcome: "paid", amount: "0.004" },
    { time: new Date(2026, 10, 11, 14, 59).toISOString(), outcome: "paid", amount: "9" },
    { time: at(14, 30), outcome: "paid", amount: "7" },
    { time: at(14, 1), outcome: "refused", amount: "5" },
    { time: at(14, 2), outcome: "free" },
    { time: at(14, 3), outcome: "paid", amount: "not a number" },
    { time: "not a time", outcome: "paid", amount: "3" },
  ];
  const { hours, total } = hourlySpend(entries, now);
  assert.equal(hours.length, 24);
  assert.equal(new Date(hours[23].start).getTime(), new Date(2026, 10, 12, 14, 0).getTime());
  assert.equal(new Date(hours[0].start).getTime(), new Date(2026, 10, 11, 15, 0).getTime());
  assert.equal(hours[23].amount, "0.3", "no floating-point drift");
  assert.equal(hours[22].amount, "0.001");
  assert.equal(hours[0].amount, "0.004", "the oldest hour is included");
  assert.equal(total, "0.305", "older and future entries, unpaid calls and bad lines are left out");
  assert.equal(hours.filter((h) => h.amount !== "0").length, 3);
});
