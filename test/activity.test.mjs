// The activity log records what each paid tool did without any secret, and the pause flag stops all spending.
// Only the user can pause or resume (CLI or dashboard); no MCP tool can. Settlement is in memory; no NGT moves.
import "./isolate.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ngtPaywall } from "../../ngtchain-paywall/dist/index.js";
import { activityLogPath, isPaused, readActivity, recordActivity, transactionOf, urlParts } from "../dist/activity.js";

const serverPath = new URL("../dist/index.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const SECRET = "s3cret-header-value";
const QUERY_SECRET = "query-secret-value";
const RESPONSE_SECRET = "response-only-value";
const TX = `0x${"ab".repeat(32)}`;

/** Fresh NGT_HOME for this test; spawned servers and the dist helpers both read it. */
function freshHome() {
  process.env.NGT_HOME = mkdtempSync(join(tmpdir(), "ngt-home-"));
  return process.env.NGT_HOME;
}

async function seller() {
  const seen = [];
  const settled = [];
  const gate = ngtPaywall({
    payTo: "0x1111111111111111111111111111111111111111",
    price: "0.002",
    facilitator: { settle: async (a) => (settled.push(a), { transaction: TX }) },
  });
  const server = createServer((req, res) => {
    seen.push(req.url);
    if (req.url.startsWith("/free")) return res.end("free page");
    gate(req, res, () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ quote: RESPONSE_SECRET }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const host = `127.0.0.1:${server.address().port}`;
  return { host, base: `http://${host}`, seen, settled, close: () => server.close() };
}

async function withServer(key, run, extraEnv = {}) {
  const env = { ...process.env, NGT_AGENT_PRIVATE_KEY: key, ...extraEnv };
  const client = new Client({ name: "activity-test", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: "ignore" }));
  try {
    return await run((name, args) => client.callTool({ name, arguments: args }), client);
  } finally {
    await client.close();
  }
}

const cli = (command) => execFileSync(process.execPath, [serverPath, command], { env: process.env, encoding: "utf8" });
const text = (result) => result.content[0].text;

test("a paid call logs one line with host, path, amount and transaction, and no secret", async () => {
  freshHome();
  const key = generatePrivateKey();
  const api = await seller();
  try {
    await withServer(
      key,
      async (call) => {
        const result = await call("pay_and_fetch", { url: `${api.base}/quote?apikey=${QUERY_SECRET}#frag` });
        assert.notEqual(result.isError, true, text(result));
      },
      { NGT_HOST_HEADERS: JSON.stringify({ [api.host]: { "x-api-key": SECRET } }) },
    );
  } finally {
    api.close();
  }
  const raw = readFileSync(activityLogPath(), "utf8");
  const lines = raw.trim().split("\n");
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.app, "activity-test");
  assert.equal(entry.tool, "pay_and_fetch");
  assert.equal(entry.host, api.host);
  assert.equal(entry.path, "/quote");
  assert.equal(entry.outcome, "paid");
  assert.equal(entry.amount, "0.002");
  assert.equal(entry.transaction, TX);
  assert.equal(entry.wallet, privateKeyToAccount(key).address);
  assert.ok(!Number.isNaN(Date.parse(entry.time)));
  for (const secret of [key.slice(2), SECRET, "x-api-key", QUERY_SECRET, "frag", RESPONSE_SECRET]) {
    assert.ok(!raw.includes(secret), `the log must not contain ${secret}`);
  }
});

test("free calls log free and refusals log refused, without the query string", async () => {
  freshHome();
  const api = await seller();
  try {
    await withServer(generatePrivateKey(), async (call) => {
      assert.notEqual((await call("pay_and_fetch", { url: `${api.base}/free` })).isError, true);
      const overCap = await call("pay_and_fetch", { url: `${api.base}/quote?apikey=${QUERY_SECRET}`, max_price_ngt: "0.001" });
      assert.equal(overCap.isError, true);
      const notHttps = await call("pay_and_fetch", { url: `ftp://example.com/x?apikey=${QUERY_SECRET}` });
      assert.equal(notHttps.isError, true);
    });
  } finally {
    api.close();
  }
  assert.equal(api.settled.length, 0);
  const [notHttps, overCap, free] = readActivity();
  assert.equal(free.outcome, "free");
  assert.equal(free.path, "/free");
  assert.equal(free.amount, undefined);
  assert.equal(overCap.outcome, "refused");
  assert.match(overCap.reason, /above the 0\.001 NGT cap/);
  assert.equal(notHttps.outcome, "refused");
  assert.equal(notHttps.reason, "not an https URL");
  assert.equal(notHttps.host, undefined, "a rejected URL is not logged");
  assert.ok(!readFileSync(activityLogPath(), "utf8").includes(QUERY_SECRET));
});

test("pause blocks both paid tools before any request; resume restores payment", async () => {
  freshHome();
  assert.match(cli("pause"), /paused in every app/);
  assert.equal(isPaused(), true);
  const api = await seller();
  try {
    await withServer(generatePrivateKey(), async (call) => {
      for (const [name, args] of [["pay_and_fetch", { url: `${api.base}/quote` }], ["fetch_ngt_stream", {}]]) {
        const result = await call(name, args);
        assert.equal(result.isError, true, name);
        assert.match(text(result), /Spending is paused by the user, so nothing was paid/);
        assert.match(text(result), /only they can resume it.*Do not retry/);
      }
      assert.equal(api.seen.length, 0, "no request is made while paused");
      assert.equal(api.settled.length, 0, "nothing is settled while paused");

      const status = JSON.parse(text(await call("ngt_wallet_status", {})));
      assert.equal(status.paused, true);

      assert.match(cli("resume"), /allowed again/);
      assert.equal(isPaused(), false);
      const paid = await call("pay_and_fetch", { url: `${api.base}/quote` });
      assert.notEqual(paid.isError, true, text(paid));
      assert.equal(api.settled.length, 1, "the running server pays again after resume");
    });
  } finally {
    api.close();
  }
  assert.deepEqual(
    readActivity().map((e) => [e.tool, e.outcome]),
    [["pay_and_fetch", "paid"], ["fetch_ngt_stream", "paused"], ["pay_and_fetch", "paused"]],
  );
});

test("no MCP tool can pause or resume spending", async () => {
  freshHome();
  await withServer(generatePrivateKey(), async (_call, client) => {
    const { tools } = await client.listTools();
    assert.ok(tools.length >= 4);
    for (const tool of tools) {
      assert.doesNotMatch(tool.name, /pause|resume/i);
      for (const arg of Object.keys(tool.inputSchema?.properties ?? {})) assert.doesNotMatch(arg, /pause|resume/i, tool.name);
    }
  });
});

test("the log keeps the newest entries under the size cap", () => {
  freshHome();
  for (let i = 0; i < 100; i++) recordActivity({ app: "a", tool: "t", outcome: "paid", reason: `entry ${i}` }, 2000);
  assert.ok(statSync(activityLogPath()).size <= 2000);
  const entries = readActivity(1000);
  assert.equal(entries[0].reason, "entry 99");
  assert.ok(entries.length > 5 && entries.length < 100);
  assert.ok(!entries.some((e) => e.reason === "entry 0"), "the oldest entries are dropped");
  const numbers = entries.map((e) => Number(e.reason.split(" ")[1]));
  assert.deepEqual(numbers, [...numbers].sort((a, b) => b - a), "newest first, no gaps in order");
});

test("malformed lines are skipped and logging never throws", () => {
  freshHome();
  const valid = (n) => JSON.stringify({ time: new Date().toISOString(), app: "a", tool: "t", outcome: "free", reason: n });
  writeFileSync(activityLogPath(), [valid("one"), "garbage", '{"time":', '{"foo":1}', valid("two"), ""].join("\n"));
  assert.deepEqual(readActivity().map((e) => e.reason), ["two", "one"]);

  process.env.NGT_HOME = activityLogPath(); // a file, so the folder cannot be created
  assert.doesNotThrow(() => recordActivity({ app: "a", tool: "t", outcome: "paid" }));
});

test("the stream reply's transaction hash is logged only when well-formed", () => {
  assert.equal(transactionOf({ stream: "open", transaction: TX, data: {} }), TX);
  for (const reply of [{ transaction: "0x1234" }, { transaction: `${TX}<b>` }, { transaction: 42 }, {}, null, "text", undefined]) {
    assert.equal(transactionOf(reply), undefined, JSON.stringify(reply));
  }
});

test("URLs are reduced to host and path, including inside reasons", () => {
  assert.deepEqual(urlParts("https://api.example.com/a/b?key=1#f"), { host: "api.example.com", path: "/a/b" });
  assert.deepEqual(urlParts("not a url"), {});
  freshHome();
  recordActivity({ app: "a", tool: "t", outcome: "failed", reason: "GET https://api.example.com/a?key=1&b=2 failed" });
  assert.equal(readActivity()[0].reason, "GET https://api.example.com/a failed");
});
