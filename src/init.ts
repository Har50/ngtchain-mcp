import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { formatUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  APPS,
  APP_NAMES,
  SERVER_NAME,
  configPath,
  hasCodexServer,
  hasServer,
  normalizePrivateKey,
  serverEntry,
  toNgt,
  toUsdc,
  withCodexServer,
  withServer,
} from "./config.js";
import { ngtBalance, openBrowser, startFundingServer, waitForBalance } from "./fund.js";

// The funding prompt suggests the session budget, but never more than this; any amount can be typed.
const MAX_SUGGESTED_FUNDING = "0.1";

/** Line prompts over one readline; `hidden` answers are not echoed (pasted keys stay off screen). */
export function prompter() {
  let muted = false;
  let cancelNote = "Nothing was written.";
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stdout.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
  rl.on("SIGINT", () => {
    process.stdout.write(`\nCancelled. ${cancelNote}\n`);
    process.exit(130);
  });
  const lines = rl[Symbol.asyncIterator]();

  async function ask(question: string, hidden = false): Promise<string> {
    if (hidden) {
      process.stdout.write(question);
      muted = true;
    } else {
      rl.setPrompt(question);
      rl.prompt();
    }
    const next = await lines.next();
    if (hidden) {
      muted = false;
      process.stdout.write("\n");
    }
    if (next.done) throw new Error("Input ended before setup finished. Nothing was written.");
    return next.value.trim();
  }

  return { ask, close: () => rl.close(), setCancelNote: (note: string) => (cancelNote = note) };
}

type Ask = (question: string, hidden?: boolean) => Promise<string>;

/** Opens a local page that asks the browser wallet to send NGT to the agent, then waits for it on Base. */
export async function fundFromBrowser(ask: Ask, address: `0x${string}`, suggested: string): Promise<boolean> {
  const amountText = (await ask(`How much NGT to send? [${suggested}]: `)) || suggested;
  const amount = toNgt(amountText);
  if (amount === null) {
    console.log("That is not an NGT amount. Skipping funding.");
    return false;
  }
  let start: bigint;
  try {
    start = await ngtBalance(address);
  } catch {
    console.log(`Could not read the wallet balance on Base. Send ${amountText} NGT to ${address} from any wallet.`);
    return false;
  }

  const page = await startFundingServer(address, amount);
  try {
    console.log(`\nOpening ${page.url} in your browser. If nothing opens, paste that address into it.`);
    console.log(`It asks your browser wallet to send ${amountText} NGT on Base to ${address}.`);
    console.log("Waiting for the NGT to arrive. Press Enter to stop waiting.");
    openBrowser(page.url);
    const balance = await waitForBalance(address, start + amount, ask("").catch(() => undefined));
    if (balance === null) {
      console.log(`Stopped waiting. You can send NGT to ${address} any time.`);
      return false;
    }
    console.log(`Received. The agent wallet holds ${formatUnits(balance, 18)} NGT.`);
    return true;
  } finally {
    page.close();
  }
}

export async function runInit(): Promise<number> {
  const { ask, close, setCancelNote } = prompter();
  try {
    console.log("\nNGT Chain MCP setup: lets your agent pay x402 APIs in NGT on Base, with caps.\n");

    console.log(`Apps: ${APPS.map((app, i) => `${i + 1}) ${APP_NAMES[app]}`).join("  ")}`);
    const picks = ((await ask("Configure which? Numbers separated by commas [1]: ")) || "1").split(/[\s,]+/).filter(Boolean);
    if (picks.some((pick) => !/^\d+$/.test(pick) || APPS[Number(pick) - 1] === undefined)) {
      console.log(`Choose numbers from 1 to ${APPS.length}, like 1 or 1,3. Nothing was written.`);
      return 1;
    }
    const apps = [...new Set(picks.map((pick) => APPS[Number(pick) - 1]))];

    console.log("\nThe agent needs its own wallet. Use a dedicated one that only holds the NGT you plan to spend.");
    const pasted = await ask("Paste its private key, or press Enter to create a new wallet (input hidden): ", true);
    let privateKey: `0x${string}`;
    let created = false;
    const normalized = normalizePrivateKey(pasted);
    if (pasted === "") {
      privateKey = generatePrivateKey();
      created = true;
    } else if (normalized) {
      privateKey = normalized;
    } else {
      console.log("That is not a private key (64 hex characters, with or without 0x). Nothing was written.");
      return 1;
    }
    const address = privateKeyToAccount(privateKey).address;

    const maxPrice = (await ask("Most one call may pay, in NGT [0.01]: ")) || "0.01";
    const sessionBudget = (await ask("Most one session may spend, in NGT [0.1]: ")) || "0.1";
    const cap = toNgt(maxPrice);
    const budget = toNgt(sessionBudget);
    if (cap === null || budget === null) {
      console.log("Amounts must be positive NGT numbers like 0.01. Nothing was written.");
      return 1;
    }
    if (cap > budget) {
      console.log("The per-call cap cannot be larger than the session budget. Nothing was written.");
      return 1;
    }

    console.log("\nSome sellers also take USDC on Base. It stays off unless you turn it on, with its own caps.");
    let usdc: { maxPrice: string; sessionBudget: string; preferred: "NGT" | "USDC" } | undefined;
    const wantsUsdc = (await ask("Also pay in USDC? [y/N]: ")).toLowerCase();
    if (wantsUsdc === "y" || wantsUsdc === "yes") {
      const usdcMaxPrice = (await ask("Most one call may pay, in USDC [0.05]: ")) || "0.05";
      const usdcSessionBudget = (await ask("Most one session may spend, in USDC [0.5]: ")) || "0.5";
      const usdcCap = toUsdc(usdcMaxPrice);
      const usdcBudget = toUsdc(usdcSessionBudget);
      if (usdcCap === null || usdcBudget === null) {
        console.log("Amounts must be positive USDC numbers like 0.05, with at most 6 decimals. Nothing was written.");
        return 1;
      }
      if (usdcCap > usdcBudget) {
        console.log("The USDC per-call cap cannot be larger than the USDC session budget. Nothing was written.");
        return 1;
      }
      const prefer = (await ask("When a seller takes both, pay USDC instead of NGT? [y/N]: ")).toLowerCase();
      usdc = { maxPrice: usdcMaxPrice, sessionBudget: usdcSessionBudget, preferred: prefer === "y" || prefer === "yes" ? "USDC" : "NGT" };
    }

    const written: string[] = [];
    for (const app of apps) {
      const path = configPath(app, process.platform, homedir(), process.env.APPDATA, process.env.CODEX_HOME);
      const existing = existsSync(path) ? readFileSync(path, "utf8") : undefined;
      const codex = app === "codex";
      try {
        if (codex ? hasCodexServer(existing, path) : hasServer(existing, path)) {
          const answer = (await ask(`${APP_NAMES[app]} already has "${SERVER_NAME}". Replace it? [y/N]: `)).toLowerCase();
          if (answer !== "y" && answer !== "yes") {
            console.log(`Left ${path} unchanged.`);
            continue;
          }
        }
        const entry = serverEntry(app, process.platform, { privateKey, maxPrice, sessionBudget, usdc });
        const text = codex ? withCodexServer(existing, entry, path) : withServer(existing, entry, path);
        mkdirSync(dirname(path), { recursive: true });
        if (existing !== undefined) copyFileSync(path, `${path}.bak`);
        writeFileSync(path, text, { mode: 0o600 });
        written.push(`${APP_NAMES[app]}: ${path}`);
      } catch (err) {
        console.log(err instanceof Error ? err.message : String(err));
      }
    }
    if (written.length === 0) return 1;
    setCancelNote("Your config was already saved.");

    console.log("\nDone.");
    for (const line of written) console.log(`  ${line}`);
    console.log(`\nAgent wallet: ${address}${created ? " (new)" : ""}`);
    console.log(`Limits: ${maxPrice} NGT per call, ${sessionBudget} NGT per session.`);
    console.log(
      usdc
        ? `USDC: on, ${usdc.maxPrice} USDC per call, ${usdc.sessionBudget} USDC per session. When a seller takes both, it pays ${usdc.preferred}.`
        : "USDC: off.",
    );
    console.log("The key is stored only in the file(s) above. Keep them private and off screen.");

    let funded = false;
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const answer = (await ask(`\nSend NGT to the agent wallet from your browser wallet now? ${created ? "[Y/n]" : "[y/N]"}: `)).toLowerCase();
      if (answer === "y" || answer === "yes" || (answer === "" && created)) {
        const suggested = budget > toNgt(MAX_SUGGESTED_FUNDING)! ? MAX_SUGGESTED_FUNDING : sessionBudget;
        funded = await fundFromBrowser(ask, address, suggested);
      }
    }
    if (created && !funded) console.log("Fund that address with a little NGT on Base. It needs no ETH.");
    if (usdc) console.log(`To pay in USDC, send USDC on Base to ${address} from your own wallet.`);
    console.log("Restart the app, then look for pay_and_fetch and fetch_ngt_stream in its MCP tools.\n");
    return 0;
  } finally {
    close();
  }
}
