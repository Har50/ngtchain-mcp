// Without a usable key, both payment tools must tell the user how to set one up and pay nothing.
import "./isolate.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = new URL("../dist/index.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

async function callBoth(key) {
  const env = { ...process.env };
  delete env.NGT_AGENT_PRIVATE_KEY;
  if (key !== undefined) env.NGT_AGENT_PRIVATE_KEY = key;
  const client = new Client({ name: "no-wallet-test", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: "ignore" }));
  try {
    return [
      await client.callTool({ name: "pay_and_fetch", arguments: { url: "http://127.0.0.1:9/never-called" } }),
      await client.callTool({ name: "fetch_ngt_stream", arguments: {} }),
    ];
  } finally {
    await client.close();
  }
}

for (const [label, key, reason] of [
  ["missing", undefined, /No wallet set up/],
  ["empty", "", /No wallet set up/],
  ["malformed", "0x1234abcd", /not a valid private key/],
]) {
  test(`${label} key: payment tools point the user to init`, async () => {
    for (const result of await callBoth(key)) {
      assert.equal(result.isError, true);
      const text = result.content[0].text;
      assert.match(text, reason);
      assert.match(text, /npx -y @ngtchain\/mcp@1.7.1 init/);
      assert.match(text, /Claude Desktop/);
      assert.match(text, /nothing was paid/);
      if (key) assert.ok(!text.includes(key.slice(2)), "the error must not echo the key");
    }
  });
}
