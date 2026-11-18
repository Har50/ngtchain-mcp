// Payment tools spend real NGT. MCP clients must see destructiveHint: true.
import "./isolate.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PAYMENT_TOOLS = ["fetch_ngt_stream", "pay_and_fetch"];

test("payment tools advertise destructiveHint: true", async () => {
  const client = new Client({ name: "destructive-hint-test", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [new URL("../dist/index.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")],
      env: { ...process.env, NGT_AGENT_PRIVATE_KEY: "0x" + "11".repeat(32) },
      stderr: "ignore",
    }),
  );

  try {
    const { tools } = await client.listTools();
    for (const name of PAYMENT_TOOLS) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, `missing tool ${name}`);
      assert.equal(
        tool.annotations?.destructiveHint,
        true,
        `${name} must set destructiveHint: true (got ${JSON.stringify(tool.annotations)})`,
      );
    }
  } finally {
    await client.close();
  }
});
