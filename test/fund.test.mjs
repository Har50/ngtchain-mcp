// The funding page must only ever see the agent's address, and must not be able to change what is sent.
import assert from "node:assert/strict";
import test from "node:test";
import { fundingPage, startFundingServer, transferData } from "../dist/fund.js";

const AGENT = "0x8Ce5EE9DCD6b961dd271995c469311a20eb23E41";
const NGT = "0xc97b05F2F68D5CED7aB65F83ab5f4f7A64d9CC44";
const ONE_CENT = 10n ** 16n; // 0.01 NGT

test("transfer calldata is NGT transfer(agent, amount)", () => {
  const data = transferData(AGENT, ONE_CENT);
  assert.equal(
    data,
    "0xa9059cbb" + AGENT.slice(2).toLowerCase().padStart(64, "0") + ONE_CENT.toString(16).padStart(64, "0"),
  );
});

test("page embeds the prepared transfer and loads nothing external", () => {
  const page = fundingPage(AGENT, ONE_CENT, "abc");
  assert.ok(page.includes(AGENT));
  assert.ok(page.includes("0.01 NGT"));
  assert.ok(page.includes(JSON.stringify({ to: NGT, data: transferData(AGENT, ONE_CENT), value: "0x0" })));
  assert.doesNotMatch(page, /<script[^>]*\ssrc=/i);
  assert.doesNotMatch(page, /<link\b|@import|fetch\(/i);
  assert.doesNotMatch(page, /private|0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/i);
});

test("server serves only GET / on 127.0.0.1 with a strict CSP", async () => {
  const server = await startFundingServer(AGENT, ONE_CENT);
  try {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const res = await fetch(server.url);
    assert.equal(res.status, 200);
    const csp = res.headers.get("content-security-policy");
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'nonce-[^']+'/);
    const nonce = csp.match(/script-src 'nonce-([^']+)'/)[1];
    assert.ok((await res.text()).includes(`<script nonce="${nonce}">`));
    assert.equal((await fetch(new URL("/done", server.url), { method: "POST" })).status, 404);
    assert.equal((await fetch(new URL("/other", server.url))).status, 404);
  } finally {
    server.close();
  }
});
