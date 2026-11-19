// `ngt-mcp init`: config merging rules, and one end-to-end run against a temp home directory.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse as parseToml } from "smol-toml";
import {
  configPath,
  hasCodexServer,
  hasServer,
  isPrivateKey,
  normalizePrivateKey,
  serverEntry,
  toNgt,
  withCodexServer,
  withServer,
} from "../dist/config.js";

const key = `0x${"1".repeat(64)}`;
const limits = { privateKey: key, maxPrice: "0.01", sessionBudget: "0.1" };

test("the entry uses the env names the server reads", () => {
  const entry = serverEntry("cursor", "win32", limits);
  assert.deepEqual(entry, {
    command: "npx",
    args: ["-y", "@ngtchain/mcp@1.7.2"],
    env: { NGT_AGENT_PRIVATE_KEY: key, NGT_MAX_PRICE: "0.01", NGT_SESSION_BUDGET: "0.1" },
  });
  for (const app of ["claude", "claude-code", "gemini", "codex"]) {
    assert.equal(serverEntry(app, "win32", limits).command, "cmd", app);
    assert.deepEqual(serverEntry(app, "win32", limits).args, ["/c", "npx", "-y", "@ngtchain/mcp@1.7.2"], app);
    assert.equal(serverEntry(app, "darwin", limits).command, "npx", app);
  }
  assert.equal(serverEntry("claude-code", "linux", limits).type, "stdio");
  assert.equal(serverEntry("gemini", "linux", limits).type, undefined);
});

test("replacing the entry keeps env vars the user added", () => {
  const old = JSON.stringify({ mcpServers: { ngtchain: { command: "npx", env: { NGT_AGENT_PRIVATE_KEY: "old", NGT_HOST_HEADERS: "{}" } } } });
  const env = JSON.parse(withServer(old, serverEntry("gemini", "linux", limits), "settings.json")).mcpServers.ngtchain.env;
  assert.equal(env.NGT_AGENT_PRIVATE_KEY, key);
  assert.equal(env.NGT_HOST_HEADERS, "{}");
});

test("Codex config.toml keeps other tables and comments, and replaces ngtchain in place", () => {
  const existing = [
    "# my settings",
    'model = "o4"',
    "",
    "[mcp_servers.ngtchain]",
    'command = "old"',
    "",
    "[mcp_servers.ngtchain.env]",
    'NGT_AGENT_PRIVATE_KEY = "old"',
    `NGT_HOST_HEADERS = '{"api.example.com":{"x-api-key":"k"}}'`,
    "",
    "[mcp_servers.other] # keep me",
    'command = "x"',
    "",
  ].join("\n");
  assert.equal(hasCodexServer(existing, "config.toml"), true);
  assert.equal(hasCodexServer('[mcp_servers.other]\ncommand = "x"\n', "config.toml"), false);
  assert.equal(hasCodexServer(undefined, "config.toml"), false);

  const text = withCodexServer(existing, serverEntry("codex", "linux", limits), "config.toml");
  assert.match(text, /^# my settings\n/);
  assert.match(text, /\[mcp_servers\.other\] # keep me/);
  assert.doesNotMatch(text, /"old"/);
  const config = parseToml(text);
  assert.equal(config.model, "o4");
  assert.deepEqual({ ...config.mcp_servers.other }, { command: "x" });
  assert.equal(config.mcp_servers.ngtchain.command, "npx");
  assert.deepEqual(config.mcp_servers.ngtchain.args, ["-y", "@ngtchain/mcp@1.7.2"]);
  assert.equal(config.mcp_servers.ngtchain.env.NGT_AGENT_PRIVATE_KEY, key);
  assert.equal(config.mcp_servers.ngtchain.env.NGT_HOST_HEADERS, '{"api.example.com":{"x-api-key":"k"}}');

  const fresh = parseToml(withCodexServer(undefined, serverEntry("codex", "win32", limits), "config.toml"));
  assert.equal(fresh.mcp_servers.ngtchain.command, "cmd");
});

test("Codex config.toml that is invalid, or defines ngtchain inline, is refused", () => {
  const entry = serverEntry("codex", "linux", limits);
  assert.throws(() => withCodexServer("model = ", entry, "config.toml"), /not valid TOML/);
  assert.throws(() => withCodexServer("mcp_servers = 3\n", entry, "config.toml"), /not a table/);
  assert.throws(
    () => withCodexServer('mcp_servers = { ngtchain = { command = "x" } }\n', entry, "config.toml"),
    /cannot edit safely/,
  );
  assert.throws(
    () => withCodexServer('[mcp_servers]\nngtchain.command = "x"\n', entry, "config.toml"),
    /cannot edit safely/,
  );
});

test("other servers and settings are kept", () => {
  const existing = JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } });
  const merged = JSON.parse(withServer(existing, serverEntry("cursor", "linux", limits), "mcp.json"));
  assert.equal(merged.theme, "dark");
  assert.deepEqual(merged.mcpServers.other, { command: "x" });
  assert.equal(merged.mcpServers.ngtchain.env.NGT_AGENT_PRIVATE_KEY, key);
  assert.equal(hasServer(JSON.stringify(merged), "mcp.json"), true);
  assert.equal(hasServer(undefined, "mcp.json"), false);
});

test("an unreadable config is refused instead of overwritten", () => {
  assert.throws(() => withServer("{ not json", serverEntry("cursor", "linux", limits), "mcp.json"), /not valid JSON/);
  assert.throws(() => withServer("[]", serverEntry("cursor", "linux", limits), "mcp.json"), /not a JSON object/);
  assert.throws(() => withServer('{"mcpServers": 3}', serverEntry("cursor", "linux", limits), "mcp.json"), /not an object/);
});

test("keys, amounts and paths are validated", () => {
  assert.equal(isPrivateKey(key), true);
  assert.equal(isPrivateKey("0x1234"), false);
  assert.equal(isPrivateKey(`0x${"1".repeat(40)}`), false);
  assert.equal(normalizePrivateKey("1".repeat(64)), key, "MetaMask exports keys without 0x");
  assert.equal(normalizePrivateKey(` "0X${"1".repeat(64)}"\n`), key);
  assert.equal(normalizePrivateKey("1".repeat(128)), null, "a key pasted twice is refused");
  assert.equal(normalizePrivateKey("1".repeat(40)), null, "an address is not a key");
  assert.equal(normalizePrivateKey(`0x${"g".repeat(64)}`), null);
  assert.equal(toNgt("0.01"), 10_000_000_000_000_000n);
  assert.equal(toNgt("0"), null);
  assert.equal(toNgt("-1"), null);
  assert.equal(toNgt("abc"), null);
  assert.match(configPath("cursor", "win32", "C:\\home"), /\.cursor[\\/]mcp\.json$/);
  assert.match(configPath("claude", "darwin", "/Users/a"), /Application Support[\\/]Claude[\\/]claude_desktop_config\.json$/);
  assert.match(configPath("claude-code", "linux", "/home/a"), /[\\/]home[\\/]a[\\/]\.claude\.json$/);
  assert.match(configPath("gemini", "linux", "/home/a"), /\.gemini[\\/]settings\.json$/);
  assert.match(configPath("codex", "linux", "/home/a"), /\.codex[\\/]config\.toml$/);
  assert.match(configPath("codex", "linux", "/home/a", undefined, "/opt/codex"), /[\\/]opt[\\/]codex[\\/]config\.toml$/);
});

function runInit(home, input) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData") };
  delete env.CODEX_HOME;
  const child = spawn(process.execPath, [new URL("../dist/index.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "init"], { env });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  child.stdin.end(input);
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, out })));
}

test("init configures Claude Code and Codex together, keeping their other settings", async () => {
  const home = mkdtempSync(join(tmpdir(), "ngt-init-"));
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ numStartups: 3, mcpServers: { other: { command: "x" } } }));
  mkdirSync(join(home, ".codex"));
  writeFileSync(join(home, ".codex", "config.toml"), '# mine\nmodel = "o4"\n');

  const { code, out } = await runInit(home, "3,5\n\n0.002\n0.01\n\n");
  assert.equal(code, 0, out);

  const claudeCode = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
  assert.equal(claudeCode.numStartups, 3);
  assert.deepEqual(claudeCode.mcpServers.other, { command: "x" });
  assert.equal(claudeCode.mcpServers.ngtchain.type, "stdio");
  const key = claudeCode.mcpServers.ngtchain.env.NGT_AGENT_PRIVATE_KEY;
  assert.ok(isPrivateKey(key));

  const codexText = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  assert.match(codexText, /^# mine\n/);
  const codex = parseToml(codexText);
  assert.equal(codex.model, "o4");
  assert.equal(codex.mcp_servers.ngtchain.env.NGT_AGENT_PRIVATE_KEY, key, "both apps get the same wallet");
  assert.equal(codex.mcp_servers.ngtchain.env.NGT_MAX_PRICE, "0.002");

  assert.ok(!out.includes(key.slice(2)), "the private key must not be printed");
  assert.ok(existsSync(join(home, ".claude.json.bak")));
  assert.ok(!existsSync(join(home, ".cursor")), "Cursor must not be touched");
  assert.ok(!existsSync(join(home, ".gemini")), "Gemini CLI must not be touched");
});

test("init refuses an unknown app number and writes nothing", async () => {
  const home = mkdtempSync(join(tmpdir(), "ngt-init-"));
  const { code, out } = await runInit(home, "1,9\n");
  assert.equal(code, 1);
  assert.match(out, /Choose numbers from 1 to 5/);
  assert.ok(!existsSync(join(home, ".cursor")));
});

test("init writes Cursor's mcp.json with a new wallet, keeps other servers, and never prints the key", async () => {
  const home = mkdtempSync(join(tmpdir(), "ngt-init-"));
  mkdirSync(join(home, ".cursor"));
  const path = join(home, ".cursor", "mcp.json");
  writeFileSync(path, JSON.stringify({ mcpServers: { other: { command: "x" } } }));

  const child = spawn(process.execPath, [new URL("../dist/index.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "init"], {
    env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData") },
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  child.stdin.end("1\n\n0.002\n0.01\n\n");
  const code = await new Promise((resolve) => child.on("close", resolve));

  assert.equal(code, 0, out);
  const config = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(config.mcpServers.other, { command: "x" });
  const env = config.mcpServers.ngtchain.env;
  assert.ok(isPrivateKey(env.NGT_AGENT_PRIVATE_KEY));
  assert.equal(env.NGT_MAX_PRICE, "0.002");
  assert.equal(env.NGT_SESSION_BUDGET, "0.01");
  assert.equal(env.NGT_USDC_MAX_PRICE, undefined, "USDC stays off unless the user says yes");
  assert.match(out, /USDC: off\./);
  assert.ok(!out.includes(env.NGT_AGENT_PRIVATE_KEY.slice(2)), "the private key must not be printed");
  assert.match(out, /Agent wallet: 0x[0-9a-fA-F]{40} \(new\)/);
  assert.ok(existsSync(`${path}.bak`));
  assert.ok(!existsSync(join(home, "AppData", "Claude")), "Claude Desktop config must not be touched");
});
