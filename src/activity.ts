import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** What happened to one paid-tool call. */
export type Outcome = "paid" | "free" | "refused" | "failed" | "paused";

/** One line of the activity log. Never holds keys, headers, query strings, request bodies or response data. */
export interface ActivityEntry {
  time: string;
  app: string;
  tool: string;
  host?: string;
  path?: string;
  outcome: Outcome;
  /** Token of `amount`. Entries written before 1.7.0 have none; they are NGT. */
  asset?: "NGT" | "USDC";
  amount?: string;
  payTo?: string;
  transaction?: string;
  wallet?: string;
  reason?: string;
}

export const MAX_LOG_BYTES = 1_000_000;
const MAX_REASON_CHARS = 200;
const MAX_PATH_CHARS = 200;

/** Folder shared by every MCP process, the CLI and the dashboard. */
export function ngtHome(): string {
  return process.env.NGT_HOME?.trim() || join(homedir(), ".ngtchain");
}

export const activityLogPath = () => join(ngtHome(), "activity.jsonl");
const pauseFlagPath = () => join(ngtHome(), "paused");

function ensureHome(): void {
  mkdirSync(ngtHome(), { recursive: true, mode: 0o700 });
}

/** Host and path only: the query string and fragment may carry secrets. */
export function urlParts(raw: string): { host?: string; path?: string } {
  try {
    const url = new URL(raw);
    return { host: url.host, path: url.pathname.slice(0, MAX_PATH_CHARS) };
  } catch {
    return {};
  }
}

/** The Base transaction hash in a seller's reply, if it holds a well-formed one. */
export function transactionOf(data: unknown): string | undefined {
  const tx = typeof data === "object" && data !== null ? (data as { transaction?: unknown }).transaction : undefined;
  return typeof tx === "string" && /^0x[0-9a-fA-F]{64}$/.test(tx) ? tx : undefined;
}

/** Appends one entry. Never throws: a logging failure must not break or block a payment. */
export function recordActivity(entry: Omit<ActivityEntry, "time">, maxBytes = MAX_LOG_BYTES): void {
  try {
    ensureHome();
    const line: ActivityEntry = { time: new Date().toISOString(), ...entry };
    if (line.reason) line.reason = line.reason.replace(/(https?:\/\/[^\s?#]*)[?#]\S*/g, "$1").slice(0, MAX_REASON_CHARS);
    const file = activityLogPath();
    appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    if (statSync(file).size > maxBytes) trimLog(file, maxBytes);
  } catch {
    // Spending is unaffected; the dashboard simply misses this line.
  }
}

/** Keeps the newest lines that fit in half of `maxBytes`. */
function trimLog(file: string, maxBytes: number): void {
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const kept: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    size += Buffer.byteLength(lines[i]) + 1;
    if (size > maxBytes / 2) break;
    kept.unshift(lines[i]);
  }
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, kept.map((line) => `${line}\n`).join(""), { mode: 0o600 });
  renameSync(temp, file);
}

/** Newest entries first. Lines that are not valid entries are skipped. */
export function readActivity(limit = 200): ActivityEntry[] {
  let text: string;
  try {
    text = readFileSync(activityLogPath(), "utf8");
  } catch {
    return [];
  }
  const entries: ActivityEntry[] = [];
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
    try {
      const entry = JSON.parse(lines[i]) as ActivityEntry;
      if (entry && typeof entry.time === "string" && typeof entry.outcome === "string") entries.push(entry);
    } catch {
      // Skip a partial or corrupted line.
    }
  }
  return entries;
}

/** Set only by the user (CLI or dashboard); no MCP tool can change it. */
export function isPaused(): boolean {
  return existsSync(pauseFlagPath());
}

export function setPaused(on: boolean): void {
  if (on) {
    ensureHome();
    writeFileSync(pauseFlagPath(), `${new Date().toISOString()}\n`, { mode: 0o600 });
  } else {
    rmSync(pauseFlagPath(), { force: true });
  }
}
