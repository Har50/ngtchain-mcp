// Test servers inherit this, so they never write to the user's real ~/.ngtchain log or read their pause flag.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NGT_HOME = mkdtempSync(join(tmpdir(), "ngt-home-"));
