// NGT_HOST_HEADERS: headers reach the configured host only, never another host or a redirect target,
// and the model never sees their values. Failures carry the next step. Settlement is in memory; no NGT moves.
import "./isolate.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { generatePrivateKey } from "viem/accounts";
import { ngtPaywall } from "../../ngtchain-paywall/dist/index.js";
import { parseHostHeaders } from "../dist/config.js";

const serverPath = new URL("../dist/index.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const SECRET = "s3cret-api-key-value";
const TX = `0x${"ef".repeat(32)}`;

/** A paywalled API that records every request's x-api-key. `settle` can be swapped to simulate failures. */
async function api({ requireKey = false, redirectTo, settle } = {}) {
  const seen = [];
  const settled = [];
  const gate = ngtPaywall({
    payTo: "0x1111111111111111111111111111111111111111",
    price: "0.002",
    facilitator: { settle: settle ?? (async (a) => (settled.push(a), { transaction: TX })) },
  });
  const server = createServer((req, res) => {
    seen.push(req.headers["x-api-key"]);
    if (redirectTo) {
      res.writeHead(302, { location: redirectTo });
      return res.end();
    }
    if (requireKey && req.headers["x-api-key"] !== SECRET) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "missing API key" }));
    }
    gate(req, res, () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ quote: 42 }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const host = `127.0.0.1:${server.address().port}`;
  return { host, url: `http://${host}/quote`, seen, settled, close: () => server.close() };
}

async function withServer(hostHeaders, run) {
  const env = { ...process.env, NGT_AGENT_PRIVATE_KEY: generatePrivateKey() };
  if (hostHeaders === undefined) delete env.NGT_HOST_HEADERS;
  else env.NGT_HOST_HEADERS = hostHeaders;
  const client = new Client({ name: "host-headers-test", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: "ignore" }));
  try {
    return await run((args) => client.callTool({ name: "pay_and_fetch", arguments: args }), client);
  } finally {
    await client.close();
  }
}

const text = (result) => result.content[0].text;

test("NGT_HOST_HEADERS is parsed strictly and errors never echo values", () => {
  const parsed = parseHostHeaders(JSON.stringify({ "API.Example.com": { "x-api-key": "v" }, "localhost:3000": {} }));
  assert.deepEqual([...parsed.keys()], ["api.example.com", "localhost:3000"]);
  assert.equal(parseHostHeaders(undefined).size, 0);
  assert.equal(parseHostHeaders("  ").size, 0);
  assert.equal(parseHostHeaders("${user_config.host_headers}").size, 0, "a blank Claude Desktop setting is unset");
  assert.throws(() => parseHostHeaders("${user_config.host_headers} x"), /not valid JSON/);

  for (const [raw, reason] of [
    [`{"api.example.com":{"x-api-key":"${SECRET}"`, /not valid JSON/],
    [`["${SECRET}"]`, /must be a JSON object/],
    [JSON.stringify({ "https://api.example.com": { k: SECRET } }), /not a host name/],
    [JSON.stringify({ "api.example.com": SECRET }), /must be an object/],
    [JSON.stringify({ "api.example.com": { "bad name": SECRET } }), /invalid header name/],
    [JSON.stringify({ "api.example.com": { "Payment-Signature": SECRET } }), /cannot set Payment-Signature/],
    [JSON.stringify({ "api.example.com": { Host: SECRET } }), /cannot set Host/],
    [JSON.stringify({ "api.example.com": { "x-api-key": `${SECRET}\r\nx-evil: 1` } }), /single-line string/],
    [JSON.stringify({ "api.example.com": { "x-api-key": 42 } }), /single-line string/],
  ]) {
    assert.throws(() => parseHostHeaders(raw), (err) => reason.test(err.message) && !err.message.includes(SECRET));
  }
});

test("the Claude Desktop extension maps an optional, sensitive setting to NGT_HOST_HEADERS", async () => {
  const { readFileSync } = await import("node:fs");
  const manifest = JSON.parse(readFileSync(new URL("../mcpb/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.server.mcp_config.env.NGT_HOST_HEADERS, "${user_config.host_headers}");
  const setting = manifest.user_config.host_headers;
  assert.equal(setting.sensitive, true);
  assert.equal(setting.required, false);
  assert.equal(setting.default, "");
});

test("headers go to the configured host and are never sent to another host", async () => {
  const keyed = await api({ requireKey: true });
  const other = await api();
  try {
    await withServer(JSON.stringify({ [keyed.host]: { "x-api-key": SECRET } }), async (call, client) => {
      const paid = await call({ url: keyed.url });
      assert.ok(!paid.isError, text(paid));
      assert.equal(JSON.parse(text(paid)).data.quote, 42);
      assert.deepEqual(keyed.seen, [SECRET, SECRET], "challenge and paid request both carry the header");
      assert.equal(keyed.settled.length, 1);
      assert.ok(!text(paid).includes(SECRET));

      const elsewhere = await call({ url: other.url });
      assert.ok(!elsewhere.isError, text(elsewhere));
      assert.deepEqual(other.seen, [undefined, undefined], "another host never gets the header");

      const status = await client.callTool({ name: "ngt_wallet_status", arguments: {} });
      assert.deepEqual(JSON.parse(text(status)).hostHeaders, { [keyed.host]: ["x-api-key"] });
      assert.ok(!text(status).includes(SECRET), "status names headers, never values");
    });
  } finally {
    keyed.close();
    other.close();
  }
});

test("a configured host that redirects is not followed, so the header reaches no other host", async () => {
  const target = await api();
  const redirecting = await api({ redirectTo: target.url });
  try {
    await withServer(JSON.stringify({ [redirecting.host]: { "x-api-key": SECRET } }), async (call) => {
      const result = await call({ url: redirecting.url });
      assert.equal(result.isError, true);
      assert.match(text(result), /redirected.*not followed/);
      assert.equal(target.seen.length, 0, "the redirect target is never contacted");
    });
  } finally {
    target.close();
    redirecting.close();
  }
});

test("malformed NGT_HOST_HEADERS pays nothing and does not leak the value", async () => {
  const seller = await api();
  try {
    await withServer(`{"${seller.host}":{"x-api-key":"${SECRET}"`, async (call, client) => {
      const result = await call({ url: seller.url });
      assert.equal(result.isError, true);
      assert.match(text(result), /NGT_HOST_HEADERS is not valid JSON, so nothing was paid/);
      assert.match(text(result), /"API key headers per host" setting/);
      assert.ok(!text(result).includes(SECRET));
      assert.equal(seller.seen.length, 0, "no request is made");
      const status = await client.callTool({ name: "ngt_wallet_status", arguments: {} });
      assert.match(JSON.parse(text(status)).hostHeaders, /^invalid/);
      assert.ok(!text(status).includes(SECRET));
    });
  } finally {
    seller.close();
  }
});

test("free and non-JSON responses are not failures, and a paid text response is counted", async () => {
  const page = createServer((req, res) => {
    if (req.url === "/big") return res.end("x".repeat(60_000));
    if (req.url === "/big.json") return res.end(JSON.stringify({ rows: "y".repeat(60_000) }));
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html>free</html>");
  });
  await new Promise((resolve) => page.listen(0, "127.0.0.1", resolve));
  const gate = ngtPaywall({
    payTo: "0x1111111111111111111111111111111111111111",
    price: "0.002",
    facilitator: { settle: async () => ({ transaction: TX }) },
  });
  const report = createServer((req, res) => gate(req, res, () => res.end("paid plain text")));
  await new Promise((resolve) => report.listen(0, "127.0.0.1", resolve));
  try {
    await withServer(undefined, async (call) => {
      const free = await call({ url: `http://127.0.0.1:${page.address().port}/` });
      assert.notEqual(free.isError, true, text(free));
      assert.deepEqual(JSON.parse(text(free)), { data: "<html>free</html>", payment: null, budgetLeft: "0.1 NGT" });

      const big = JSON.parse(text(await call({ url: `http://127.0.0.1:${page.address().port}/big` })));
      assert.equal(big.data, "x".repeat(50_000), "a large page is cut before it reaches the model");
      assert.equal(big.truncated, "Only the first 50,000 of 60,000 characters are shown.");
      const bigJson = JSON.parse(text(await call({ url: `http://127.0.0.1:${page.address().port}/big.json` })));
      assert.equal(bigJson.data.length, 50_000, "oversized JSON is cut too");
      assert.match(bigJson.truncated, /^Only the first 50,000 of 60,0\d\d characters are shown\.$/);

      const paid = await call({ url: `http://127.0.0.1:${report.address().port}/` });
      assert.notEqual(paid.isError, true, text(paid));
      const body = JSON.parse(text(paid));
      assert.equal(body.data, "paid plain text");
      assert.equal(body.payment.amount, "0.002");
      assert.equal(body.budgetLeft, "0.098 NGT", "the payment is taken from the session budget");
    });
  } finally {
    page.close();
    report.close();
  }
});

test("each failure says what to do next, and a 402 never asks for funding by itself", async () => {
  const broke = await api({ settle: async () => { throw new Error("reverted with signature 0xe450d38c"); } });
  const blocked = await api({ requireKey: true });
  try {
    await withServer(undefined, async (call) => {
      const lowBalance = await call({ url: broke.url });
      assert.equal(lowBalance.isError, true);
      assert.match(text(lowBalance), /wallet has insufficient NGT/);
      assert.match(text(lowBalance), /call ngt_wallet_status.*fund_agent_wallet only if the user agrees/i);

      const overCap = await call({ url: broke.url, max_price_ngt: "0.001" });
      assert.match(text(overCap), /above the 0\.001 NGT cap.*max_price_ngt was 0\.001 NGT.*Do not retry/);
      assert.doesNotMatch(text(overCap), /fund_agent_wallet/);

      const refused = await call({ url: blocked.url });
      assert.match(text(refused), /Unexpected status code: 401.*Nothing was paid.*Do not retry/);
      assert.doesNotMatch(text(refused), /fund_agent_wallet/);
    });
  } finally {
    broke.close();
    blocked.close();
  }
});
