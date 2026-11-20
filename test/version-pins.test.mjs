// Every @ngtchain/mcp@x.y.z pin and every manifest version must equal package.json's version,
// so a release can never again ship messages or `init` configs that point at an older version.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (p) => readFileSync(join(root, p), "utf8");
const version = JSON.parse(read("package.json")).version;

const pinFiles = [
  "README.md",
  "ngtchain/.mcp.json",
  ...readdirSync(join(root, "src")).filter((f) => f.endsWith(".ts")).map((f) => `src/${f}`),
];

test("every @ngtchain/mcp@x.y.z pin matches package.json", () => {
  for (const file of pinFiles) {
    for (const [, pinned] of read(file).matchAll(/@ngtchain\/mcp@(\d+\.\d+\.\d+)/g)) {
      assert.equal(pinned, version, `${file} pins @ngtchain/mcp@${pinned}, package.json is ${version}`);
    }
  }
});

test("manifests, registry entry, plugin and packer carry package.json's version", () => {
  for (const file of ["manifest.json", "mcpb/manifest.json", "ngtchain/.claude-plugin/plugin.json"]) {
    assert.equal(JSON.parse(read(file)).version, version, file);
  }
  const server = JSON.parse(read("server.json"));
  assert.equal(server.version, version, "server.json version");
  for (const pkg of server.packages ?? []) assert.equal(pkg.version, version, "server.json packages[].version");
  assert.match(read("pack-mcp.js"), new RegExp(`VERSION = "${version.replaceAll(".", "\\.")}"`), "pack-mcp.js VERSION");
});
