import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { parseUnits } from "viem";

export const SERVER_NAME = "ngtchain";

export type App = "cursor" | "claude" | "claude-code" | "gemini" | "codex";

export const APPS: readonly App[] = ["cursor", "claude", "claude-code", "gemini", "codex"];

export const APP_NAMES: Record<App, string> = {
  cursor: "Cursor",
  claude: "Claude Desktop",
  "claude-code": "Claude Code",
  gemini: "Gemini CLI",
  codex: "Codex",
};

export interface ServerEntry {
  type?: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function isPrivateKey(value: string): value is `0x${string}` {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

/** The key as 0x + 64 hex. Also accepts it without 0x (as MetaMask exports it), quoted, or with stray spaces. */
export function normalizePrivateKey(value: string): `0x${string}` | null {
  const key = value.trim().replace(/^['"]|['"]$/g, "").replace(/\s+/g, "");
  const prefixed = /^0x/i.test(key) ? `0x${key.slice(2)}` : `0x${key}`;
  return isPrivateKey(prefixed) ? prefixed : null;
}

/** Positive NGT amount with at most 18 decimals, or null. */
export function toNgt(value: string): bigint | null {
  if (!/^\d+(\.\d{1,18})?$/.test(value)) return null;
  const amount = parseUnits(value, 18);
  return amount > 0n ? amount : null;
}

/** Positive USDC amount with at most 6 decimals, or null. */
export function toUsdc(value: string): bigint | null {
  if (!/^\d+(\.\d{1,6})?$/.test(value)) return null;
  const amount = parseUnits(value, 6);
  return amount > 0n ? amount : null;
}

export type Currency = "NGT" | "USDC";

export interface UsdcSettings {
  /** Per-call cap and session budget in USDC base units; 0 means off. */
  maxPrice: bigint;
  sessionBudget: bigint;
  /** USDC is paid only when both are above zero. */
  enabled: boolean;
  preferred: Currency;
}

const unset = (raw: string | undefined) =>
  raw === undefined || raw.trim() === "" || /^\$\{user_config\.[\w-]+\}$/.test(raw.trim());

/** Reads NGT_USDC_MAX_PRICE, NGT_USDC_SESSION_BUDGET and NGT_PREFERRED_CURRENCY. Throws on a malformed value. */
export function parseUsdcSettings(env: Record<string, string | undefined>): UsdcSettings {
  const amount = (name: string) => {
    const raw = env[name];
    if (unset(raw) || raw!.trim() === "0") return 0n;
    const value = toUsdc(raw!.trim());
    if (value === null) throw new Error(`${name} must be a USDC amount like 0.05 (at most 6 decimals), or 0 to keep USDC off`);
    return value;
  };
  const maxPrice = amount("NGT_USDC_MAX_PRICE");
  const sessionBudget = amount("NGT_USDC_SESSION_BUDGET");
  const rawPreferred = env.NGT_PREFERRED_CURRENCY;
  const preferred = unset(rawPreferred) ? "NGT" : rawPreferred!.trim().toUpperCase();
  if (preferred !== "NGT" && preferred !== "USDC") throw new Error("NGT_PREFERRED_CURRENCY must be NGT or USDC");
  return { maxPrice, sessionBudget, enabled: maxPrice > 0n && sessionBudget > 0n, preferred };
}

export function configPath(app: App, platform: NodeJS.Platform, home: string, appData?: string, codexHome?: string): string {
  if (app === "cursor") return join(home, ".cursor", "mcp.json");
  if (app === "claude-code") return join(home, ".claude.json");
  if (app === "gemini") return join(home, ".gemini", "settings.json");
  if (app === "codex") return join(codexHome || join(home, ".codex"), "config.toml");
  if (platform === "win32") return join(appData ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  if (platform === "darwin") return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  return join(home, ".config", "Claude", "claude_desktop_config.json");
}

export function serverEntry(
  app: App,
  platform: NodeJS.Platform,
  limits: {
    privateKey: string;
    maxPrice: string;
    sessionBudget: string;
    usdc?: { maxPrice: string; sessionBudget: string; preferred: Currency };
  },
): ServerEntry {
  // On Windows only Cursor spawns npx.cmd directly; the other apps need cmd /c.
  const viaCmd = platform === "win32" && app !== "cursor";
  return {
    ...(app === "claude-code" ? { type: "stdio" as const } : {}),
    command: viaCmd ? "cmd" : "npx",
    args: viaCmd ? ["/c", "npx", "-y", "@ngtchain/mcp@1.7.4"] : ["-y", "@ngtchain/mcp@1.7.4"],
    env: {
      NGT_AGENT_PRIVATE_KEY: limits.privateKey,
      NGT_MAX_PRICE: limits.maxPrice,
      NGT_SESSION_BUDGET: limits.sessionBudget,
      ...(limits.usdc
        ? {
            NGT_USDC_MAX_PRICE: limits.usdc.maxPrice,
            NGT_USDC_SESSION_BUDGET: limits.usdc.sessionBudget,
            NGT_PREFERRED_CURRENCY: limits.usdc.preferred,
          }
        : {}),
    },
  };
}

// init sets these on every run, so an answer of "no USDC" must not inherit them from the old entry.
const INIT_OWNED_ENV = ["NGT_USDC_MAX_PRICE", "NGT_USDC_SESSION_BUDGET", "NGT_PREFERRED_CURRENCY"];

const isTable = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The new entry, keeping env vars the user added to the old one (such as NGT_HOST_HEADERS). */
function replacing(old: unknown, entry: ServerEntry): ServerEntry {
  const oldEnv = { ...(isTable(old) && isTable(old.env) ? (old.env as Record<string, string>) : {}) };
  for (const name of INIT_OWNED_ENV) delete oldEnv[name];
  return { ...entry, env: { ...oldEnv, ...entry.env } };
}

type Config = { mcpServers: Record<string, unknown>; [key: string]: unknown };

function parseConfig(existing: string | undefined, label: string): Config {
  if (existing === undefined || existing.trim() === "") return { mcpServers: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    throw new Error(`${label} is not valid JSON. Fix or move it and run init again; it was not changed.`);
  }
  if (!isTable(parsed)) {
    throw new Error(`${label} is not a JSON object. It was not changed.`);
  }
  const config = parsed as Config;
  if (config.mcpServers === undefined) config.mcpServers = {};
  if (!isTable(config.mcpServers)) {
    throw new Error(`${label} has an mcpServers value that is not an object. It was not changed.`);
  }
  return config;
}

export function hasServer(existing: string | undefined, label: string): boolean {
  return SERVER_NAME in parseConfig(existing, label).mcpServers;
}

/** Returns the new file text with the ngtchain server set; every other key is kept. Throws on unreadable input. */
export function withServer(existing: string | undefined, entry: ServerEntry, label: string): string {
  const config = parseConfig(existing, label);
  config.mcpServers[SERVER_NAME] = replacing(config.mcpServers[SERVER_NAME], entry);
  return `${JSON.stringify(config, null, 2)}\n`;
}

function parseCodex(existing: string | undefined, label: string): Record<string, unknown> {
  if (existing === undefined || existing.trim() === "") return {};
  try {
    return parseToml(existing);
  } catch {
    throw new Error(`${label} is not valid TOML. Fix or move it and run init again; it was not changed.`);
  }
}

export function hasCodexServer(existing: string | undefined, label: string): boolean {
  const servers = parseCodex(existing, label).mcp_servers;
  return isTable(servers) && SERVER_NAME in servers;
}

// Header of the [mcp_servers.ngtchain] table or one of its subtables, such as [mcp_servers.ngtchain.env].
const NGT_TABLE = /^\s*\[\s*mcp_servers\s*\.\s*(?:ngtchain|"ngtchain")\s*(?:\.[^\]]*)?\]\s*(?:#.*)?$/;
const ANY_TABLE = /^\s*\[/;

const withoutNgt = (config: Record<string, unknown>) => {
  const copy = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  if (isTable(copy.mcp_servers)) {
    delete copy.mcp_servers[SERVER_NAME];
    if (Object.keys(copy.mcp_servers).length === 0) delete copy.mcp_servers;
  }
  return copy;
};

/**
 * Codex config.toml with [mcp_servers.ngtchain] set. Other lines, comments included, are kept as written.
 * The result is parsed back and must equal the old config apart from ngtchain, or nothing is returned.
 */
export function withCodexServer(existing: string | undefined, entry: ServerEntry, label: string): string {
  const before = parseCodex(existing, label);
  if (before.mcp_servers !== undefined && !isTable(before.mcp_servers)) {
    throw new Error(`${label} has an mcp_servers value that is not a table. It was not changed.`);
  }
  const merged = replacing(isTable(before.mcp_servers) ? before.mcp_servers[SERVER_NAME] : undefined, entry);

  const kept: string[] = [];
  let inNgtTable = false;
  for (const line of (existing ?? "").split(/\r?\n/)) {
    if (NGT_TABLE.test(line)) inNgtTable = true;
    else if (ANY_TABLE.test(line)) inNgtTable = false;
    if (!inNgtTable) kept.push(line);
  }
  const head = kept.join("\n").trimEnd();
  const text = `${head ? `${head}\n\n` : ""}${stringifyToml({ mcp_servers: { [SERVER_NAME]: merged } })}\n`;

  let after: Record<string, unknown>;
  try {
    after = parseToml(text);
  } catch {
    after = {};
  }
  const written = isTable(after.mcp_servers) ? after.mcp_servers[SERVER_NAME] : undefined;
  if (!isDeepStrictEqual(withoutNgt(after), withoutNgt(before)) || !isDeepStrictEqual(JSON.parse(JSON.stringify(written ?? null)), merged)) {
    throw new Error(`${label} defines ${SERVER_NAME} in a form init cannot edit safely. Edit it by hand; it was not changed.`);
  }
  return text;
}

/** Headers to add per host, keyed by URL host (hostname, plus :port when not the default). */
export type HostHeaders = Map<string, Record<string, string>>;

// Set by the payment flow itself; a configured header must not replace them.
const RESERVED_HEADERS = new Set(["host", "content-length", "content-type", "payment-signature", "transfer-encoding", "connection"]);

/**
 * Parses NGT_HOST_HEADERS, e.g. {"api.example.com":{"x-api-key":"..."}}. Throws on anything malformed.
 * Error messages name hosts and header names only, never values.
 */
export function parseHostHeaders(raw: string | undefined): HostHeaders {
  const result: HostHeaders = new Map();
  // A Claude Desktop extension may pass an optional setting left blank through as its placeholder.
  if (raw === undefined || raw.trim() === "" || /^\$\{user_config\.[\w-]+\}$/.test(raw.trim())) return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("NGT_HOST_HEADERS is not valid JSON");
  }
  if (!isTable(parsed)) throw new Error("NGT_HOST_HEADERS must be a JSON object of hosts");
  for (const [rawHost, headers] of Object.entries(parsed)) {
    const host = rawHost.trim().toLowerCase();
    if (!/^(?:\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/.test(host)) {
      throw new Error(`NGT_HOST_HEADERS host "${rawHost}" is not a host name (use api.example.com, or localhost:3000 with a port)`);
    }
    if (!isTable(headers)) throw new Error(`NGT_HOST_HEADERS["${host}"] must be an object of header names to values`);
    const clean: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new Error(`NGT_HOST_HEADERS["${host}"] has an invalid header name`);
      if (RESERVED_HEADERS.has(name.toLowerCase())) throw new Error(`NGT_HOST_HEADERS["${host}"] cannot set ${name}`);
      if (typeof value !== "string" || /[\r\n\0]/.test(value)) {
        throw new Error(`NGT_HOST_HEADERS["${host}"].${name} must be a single-line string`);
      }
      clean[name] = value;
    }
    result.set(host, clean);
  }
  return result;
}
