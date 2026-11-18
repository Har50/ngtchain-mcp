// End to end: the built MCP server's pay_and_fetch tool pays a local @ngtchain/paywall
// seller whose wallet is not the NGT treasury. Settlement uses an in-memory facilitator,
// so no NGT moves. Run after building both packages: node test/pay-and-fetch.e2e.mjs
import "./isolate.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { generatePrivateKey } from "viem/accounts";
import { ngtPaywall } from "../../ngtchain-paywall/dist/index.js";

const seller = "0x1111111111111111111111111111111111111111";
const settled = [];
const gate = ngtPaywall({
  payTo: seller,
  price: "0.002",
  facilitator: { settle: async (a) => (settled.push(a), { transaction: `0x${"ef".repeat(32)}` }) },
});
const api = createServer((req, res) =>
  gate(req, res, () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ quote: 42 }));
  }),
);
await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${api.address().port}/quote`;

const client = new Client({ name: "e2e", version: "1" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [new URL("../dist/index.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")],
    env: { ...process.env, NGT_AGENT_PRIVATE_KEY: generatePrivateKey(), NGT_SESSION_BUDGET: "0.003" },
    stderr: "ignore",
  }),
);

const call = (args) => client.callTool({ name: "pay_and_fetch", arguments: args });
const text = (r) => r.content[0].text;

try {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["fetch_ngt_stream", "fund_agent_wallet", "ngt_wallet_status", "pay_and_fetch"]);

  const refusedCap = await call({ url, max_price_ngt: "0.001" });
  assert.equal(refusedCap.isError, true);
  assert.match(text(refusedCap), /above the 0\.001 NGT cap/);
  assert.equal(settled.length, 0);
  console.log("PASS  refuses a price above the per-call cap");

  const paid = await call({ url });
  assert.ok(!paid.isError, text(paid));
  const body = JSON.parse(text(paid));
  assert.equal(body.data.quote, 42);
  assert.equal(body.payment.payTo, seller);
  assert.equal(body.payment.amount, "0.002");
  assert.equal(body.budgetLeft, "0.001 NGT");
  assert.equal(settled.length, 1);
  console.log(`PASS  pays a third-party seller: ${text(paid).replace(/\s+/g, " ")}`);

  const overBudget = await call({ url });
  assert.equal(overBudget.isError, true);
  assert.match(text(overBudget), /above the 0\.001 NGT cap/);
  assert.equal(settled.length, 1);
  console.log("PASS  stops when the session budget cannot cover the price");

  const insecure = await call({ url: "http://example.com/quote" });
  assert.equal(insecure.isError, true);
  console.log("PASS  refuses plain http to remote hosts");
} finally {
  await client.close();
  api.close();
}
