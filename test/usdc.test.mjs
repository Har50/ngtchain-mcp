// USDC is opt-in, with its own per-call cap and session budget. Nothing is converted between NGT and USDC.
// Sellers are @ngtchain/paywall 0.2.0 servers with an in-memory facilitator; no tokens move.
import "./isolate.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { generatePrivateKey } from "viem/accounts";
import { ngtPaywall } from "../../ngtchain-paywall/dist/index.js";
import { recordActivity } from "../dist/activity.js";
import { parseUsdcSettings, serverEntry, withServer as withConfig } from "../dist/config.js";
import { hourlySpend, spentSince, startDashboard } from "../dist/dashboard.js";

const serverPath = new URL("../dist/index.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const NGT = "0xc97b05F2F68D5CED7aB65F83ab5f4f7A64d9CC44";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const TX = `0x${"ef".repeat(32)}`;
const USDC_ENV = ["NGT_USDC_MAX_PRICE", "NGT_USDC_SESSION_BUDGET", "NGT_PREFERRED_CURRENCY"];

async function seller(accept) {
  const settled = [];
  const gate = ngtPaywall({ payTo: PAY_TO, accept, facilitator: { settle: async (a) => (settled.push(a), { transaction: TX }) } });
  const server = createServer((req, res) =>
    gate(req, res, () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ quote: 42 }));
    }),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/quote`, settled, close: () => server.close() };
}

async function withServer(extra, run) {
  const env = { ...process.env, NGT_AGENT_PRIVATE_KEY: generatePrivateKey() };
  for (const name of [...USDC_ENV, "NGT_HOST_HEADERS", "NGT_MAX_PRICE", "NGT_SESSION_BUDGET"]) delete env[name];
  Object.assign(env, extra);
  const client = new Client({ name: "usdc-test", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: "ignore" }));
  try {
    const call = async (args) => {
      const result = await client.callTool({ name: "pay_and_fetch", arguments: args });
      const text = result.content[0].text;
      return { error: result.isError === true, text, body: result.isError ? undefined : JSON.parse(text) };
    };
    const status = async () => JSON.parse((await client.callTool({ name: "ngt_wallet_status", arguments: {} })).content[0].text);
    return await run({ call, status, client });
  } finally {
    await client.close();
  }
}

const both = () => seller([{ asset: "NGT", price: "0.001" }, { asset: "USDC", price: "0.0025" }]);
const usdcOnly = () => seller([{ asset: "USDC", price: "0.0025" }]);

test("the dashboard keeps USDC totals apart; the chart and NGT totals count NGT only", async () => {
  const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const entries = [
    { time: at(1), outcome: "paid", amount: "0.002" },
    { time: at(2), outcome: "paid", asset: "NGT", amount: "0.001" },
    { time: at(3), outcome: "paid", asset: "USDC", amount: "0.0025" },
    { time: at(4), outcome: "refused", asset: "USDC", amount: "9" },
  ];
  const hourAgo = new Date(Date.now() - 3_600_000);
  assert.equal(spentSince(entries, hourAgo), "0.003", "entries without an asset are NGT");
  assert.equal(spentSince(entries, hourAgo, "USDC"), "0.0025");
  assert.equal(hourlySpend(entries, new Date()).total, "0.003", "USDC never enters the NGT chart");

  const dashboard = await startDashboard({ balanceOf: async () => 0n });
  const get = (path, token) =>
    new Promise((resolve, reject) => {
      const req = request(`${dashboard.url}${path}`, { headers: token ? { "x-ngt-token": token } : {}, agent: false }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve(body));
      });
      req.on("error", reject);
      req.end();
    });
  try {
    const token = /const TOKEN = "([0-9a-f]+)"/.exec(await get(""))[1];
    assert.equal(JSON.parse(await get("api/state", token)).usdc, null, "no USDC cards until USDC is paid");
    recordActivity({ app: "t", tool: "pay_and_fetch", outcome: "paid", amount: "0.002" });
    recordActivity({ app: "t", tool: "pay_and_fetch", outcome: "paid", asset: "USDC", amount: "0.0025" });
    const state = JSON.parse(await get("api/state", token));
    assert.equal(state.spentToday, "0.002");
    assert.equal(state.spentInChart, "0.002");
    assert.deepEqual(state.usdc, { spentLastHour: "0.0025", spentToday: "0.0025" });
    assert.equal(state.paidCallsToday, 2);
  } finally {
    dashboard.close();
  }
});

test("USDC settings: off unless both amounts are above zero, and malformed values are errors", () => {
  const off = { maxPrice: 0n, sessionBudget: 0n, enabled: false, preferred: "NGT" };
  assert.deepEqual(parseUsdcSettings({}), off);
  assert.deepEqual(parseUsdcSettings({ NGT_USDC_MAX_PRICE: "${user_config.usdc_max_price}", NGT_PREFERRED_CURRENCY: "${user_config.preferred_currency}" }), off);
  assert.deepEqual(parseUsdcSettings({ NGT_USDC_MAX_PRICE: "0", NGT_USDC_SESSION_BUDGET: "0" }), off);
  assert.equal(parseUsdcSettings({ NGT_USDC_MAX_PRICE: "0.05" }).enabled, false, "a cap without a budget is still off");
  assert.equal(parseUsdcSettings({ NGT_USDC_SESSION_BUDGET: "1" }).enabled, false);
  assert.deepEqual(parseUsdcSettings({ NGT_USDC_MAX_PRICE: "0.05", NGT_USDC_SESSION_BUDGET: "0.5", NGT_PREFERRED_CURRENCY: " usdc " }), {
    maxPrice: 50_000n,
    sessionBudget: 500_000n,
    enabled: true,
    preferred: "USDC",
  });
  assert.throws(() => parseUsdcSettings({ NGT_USDC_MAX_PRICE: "0.0000001" }), /NGT_USDC_MAX_PRICE must be a USDC amount/);
  assert.throws(() => parseUsdcSettings({ NGT_USDC_SESSION_BUDGET: "-1" }), /NGT_USDC_SESSION_BUDGET must be a USDC amount/);
  assert.throws(() => parseUsdcSettings({ NGT_PREFERRED_CURRENCY: "EUR" }), /NGT_PREFERRED_CURRENCY must be NGT or USDC/);
});

test("init writes USDC settings only when asked, and a later 'no' removes them", () => {
  const limits = { privateKey: `0x${"1".repeat(64)}`, maxPrice: "0.01", sessionBudget: "0.1" };
  const usdc = { maxPrice: "0.05", sessionBudget: "0.5", preferred: "NGT" };
  assert.deepEqual(serverEntry("cursor", "linux", { ...limits, usdc }).env, {
    NGT_AGENT_PRIVATE_KEY: limits.privateKey,
    NGT_MAX_PRICE: "0.01",
    NGT_SESSION_BUDGET: "0.1",
    NGT_USDC_MAX_PRICE: "0.05",
    NGT_USDC_SESSION_BUDGET: "0.5",
    NGT_PREFERRED_CURRENCY: "NGT",
  });
  const withUsdc = withConfig(undefined, serverEntry("cursor", "linux", { ...limits, usdc }), "mcp.json");
  const old = JSON.parse(withUsdc);
  old.mcpServers.ngtchain.env.NGT_HOST_HEADERS = "{}";
  const env = JSON.parse(withConfig(JSON.stringify(old), serverEntry("cursor", "linux", limits), "mcp.json")).mcpServers.ngtchain.env;
  for (const name of USDC_ENV) assert.equal(env[name], undefined, name);
  assert.equal(env.NGT_HOST_HEADERS, "{}", "settings init does not own are kept");
});

test("init asks about USDC and writes its caps and preference", async () => {
  const home = mkdtempSync(join(tmpdir(), "ngt-init-"));
  const run = (input) => {
    const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData") };
    const child = spawn(process.execPath, [serverPath, "init"], { env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.stdin.end(input);
    return new Promise((resolve) => child.on("close", (code) => resolve({ code, out })));
  };
  const bad = await run("1\n\n0.002\n0.01\ny\n0.0000001\n0.5\n");
  assert.equal(bad.code, 1);
  assert.match(bad.out, /at most 6 decimals\. Nothing was written/);
  const over = await run("1\n\n0.002\n0.01\ny\n1\n0.5\n");
  assert.match(over.out, /USDC per-call cap cannot be larger than the USDC session budget/);

  const ok = await run("1\n\n0.002\n0.01\ny\n0.05\n0.5\ny\n");
  assert.equal(ok.code, 0, ok.out);
  const env = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers.ngtchain.env;
  assert.equal(env.NGT_USDC_MAX_PRICE, "0.05");
  assert.equal(env.NGT_USDC_SESSION_BUDGET, "0.5");
  assert.equal(env.NGT_PREFERRED_CURRENCY, "USDC");
  assert.match(ok.out, /USDC: on, 0\.05 USDC per call, 0\.5 USDC per session\. When a seller takes both, it pays USDC\./);
});

test("USDC is off by default: a seller taking both is paid in NGT, and a USDC-only seller is refused", async () => {
  const a = await both();
  const b = await usdcOnly();
  try {
    await withServer({}, async ({ call, status, client }) => {
      const paid = await call({ url: a.url, max_price_usdc: "1" });
      assert.equal(paid.error, false, paid.text);
      assert.equal(paid.body.payment.asset, "NGT");
      assert.equal(paid.body.payment.amount, "0.001");
      assert.equal(paid.body.budgetLeft, "0.099 NGT");
      assert.equal("usdcBudgetLeft" in paid.body, false);
      assert.equal(a.settled[0].asset, NGT);

      const refused = await call({ url: b.url, max_price_usdc: "1" });
      assert.equal(refused.error, true);
      assert.match(refused.text, /takes USDC but not NGT, and USDC is off.*NGT_USDC_MAX_PRICE and NGT_USDC_SESSION_BUDGET/);
      assert.equal(b.settled.length, 0);

      assert.doesNotMatch(client.getInstructions(), /USDC/);
      const tool = (await client.listTools()).tools.find((t) => t.name === "pay_and_fetch");
      assert.equal(tool.title, "Pay and Fetch [Paid: NGT, capped]");
      assert.match((await status()).usdc, /^off/);
    });
    const log = readFileSync(join(process.env.NGT_HOME, "activity.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const host = new URL(a.url).host;
    assert.equal(log.find((e) => e.host === host && e.outcome === "paid").asset, "NGT");
  } finally {
    a.close();
    b.close();
  }
});

test("with USDC on, NGT is paid first, USDC is used where NGT is not offered, and the budgets stay separate", async () => {
  const a = await both();
  const b = await usdcOnly();
  try {
    await withServer({ NGT_USDC_MAX_PRICE: "0.01", NGT_USDC_SESSION_BUDGET: "0.006" }, async ({ call, status, client }) => {
      assert.match(client.getInstructions(), /also allows USDC.*when a seller takes both, it pays NGT\./);
      const st = await status();
      assert.equal(st.usdc.perCallCap, "0.01 USDC");
      assert.equal(st.usdc.sessionBudgetLeft, "0.006 USDC");
      assert.equal(st.usdc.paysWhenSellerTakesBoth, "NGT");
      assert.match(st.usdc.balance, / USDC$|^unknown/);

      const first = await call({ url: a.url });
      assert.equal(first.body.payment.asset, "NGT");
      assert.equal(first.body.budgetLeft, "0.099 NGT");
      assert.equal(first.body.usdcBudgetLeft, "0.006 USDC");

      const usdc1 = await call({ url: b.url });
      assert.deepEqual(usdc1.body.payment, { amount: "0.0025", asset: "USDC", payTo: PAY_TO, transaction: TX });
      assert.equal(usdc1.body.usdcBudgetLeft, "0.0035 USDC");
      assert.equal(usdc1.body.budgetLeft, "0.099 NGT", "a USDC payment never touches the NGT budget");
      assert.equal(b.settled[0].asset, USDC);
      assert.equal(b.settled[0].value, "2500");

      const usdc2 = await call({ url: b.url });
      assert.equal(usdc2.body.usdcBudgetLeft, "0.001 USDC");

      const over = await call({ url: b.url });
      assert.equal(over.error, true);
      assert.match(over.text, /0\.0025 USDC; above the 0\.001 USDC cap.*Only 0\.001 USDC of the USDC session budget is left.*Do not retry/);
      assert.equal(b.settled.length, 2);

      const fallback = await call({ url: a.url });
      assert.equal(fallback.body.payment.asset, "NGT", "NGT still pays when the USDC budget is nearly used");
      assert.equal(fallback.body.budgetLeft, "0.098 NGT");
      assert.equal((await status()).usdc.sessionBudgetLeft, "0.001 USDC");
    });
  } finally {
    a.close();
    b.close();
  }
});

test("NGT_PREFERRED_CURRENCY=USDC pays USDC when a seller takes both, and max_price_usdc can only lower the USDC cap", async () => {
  const a = await both();
  const pricey = await seller([{ asset: "NGT", price: "0.001" }, { asset: "USDC", price: "0.02" }]);
  try {
    await withServer({ NGT_USDC_MAX_PRICE: "0.01", NGT_USDC_SESSION_BUDGET: "0.1", NGT_PREFERRED_CURRENCY: "usdc" }, async ({ call, status, client }) => {
      assert.match(client.getInstructions(), /it pays USDC, as the user prefers/);
      assert.equal((await status()).usdc.paysWhenSellerTakesBoth, "USDC");

      assert.equal((await call({ url: a.url })).body.payment.asset, "USDC");
      assert.equal((await call({ url: a.url, max_price_usdc: "0.002" })).body.payment.asset, "NGT");
      assert.equal((await call({ url: pricey.url, max_price_usdc: "5" })).body.payment.asset, "NGT", "the server cap still applies");

      const bad = await call({ url: a.url, max_price_usdc: "lots" });
      assert.match(bad.text, /max_price_usdc lots is not a USDC amount/);
      assert.equal(a.settled.length, 2);
    });
  } finally {
    a.close();
    pricey.close();
  }
});

test("malformed USDC settings pay nothing and say what to fix", async () => {
  const a = await both();
  try {
    for (const [extra, reason] of [
      [{ NGT_USDC_MAX_PRICE: "lots", NGT_USDC_SESSION_BUDGET: "1" }, /NGT_USDC_MAX_PRICE must be a USDC amount/],
      [{ NGT_PREFERRED_CURRENCY: "EUR" }, /NGT_PREFERRED_CURRENCY must be NGT or USDC/],
    ]) {
      await withServer(extra, async ({ call, status }) => {
        const result = await call({ url: a.url });
        assert.equal(result.error, true);
        assert.match(result.text, reason);
        assert.match(result.text, /so nothing was paid/);
        assert.match((await status()).usdc, /^invalid/);
      });
    }
    assert.equal(a.settled.length, 0);
  } finally {
    a.close();
  }
});
