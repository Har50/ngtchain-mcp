// `--help` must print usage and exit, not start the stdio server and wait.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const serverPath = new URL("../dist/index.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

for (const flag of ["--help", "-h", "help"]) {
  test(`${flag} prints usage and exits`, () => {
    const run = spawnSync(process.execPath, [serverPath, flag], { encoding: "utf8", timeout: 10_000 });
    assert.equal(run.status, 0, `exit ${run.status}, signal ${run.signal}`);
    assert.match(run.stdout, /Usage:/);
    assert.match(run.stdout, /npx -y @ngtchain\/mcp@\d+\.\d+\.\d+ init/);
    assert.match(run.stdout, /NGT_AGENT_PRIVATE_KEY/);
  });
}
