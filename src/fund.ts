import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ASSETS, NGT_CONTRACT_ADDRESS } from "@ngtchain/client";
import { createPublicClient, encodeFunctionData, erc20Abi, formatUnits, http } from "viem";
import { base } from "viem/chains";

const BASE_CHAIN_ID = "0x2105";

/** Calldata for NGT transfer(to, amount). Built here so the page cannot change the recipient or amount. */
export function transferData(to: `0x${string}`, amount: bigint): `0x${string}` {
  return encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] });
}

/** A page with no external resources; its only job is to hand one prepared transfer to the browser wallet. */
export function fundingPage(to: `0x${string}`, amount: bigint, nonce: string): string {
  const tx = { to: NGT_CONTRACT_ADDRESS, data: transferData(to, amount), value: "0x0" };
  const shown = formatUnits(amount, 18);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Fund your NGT agent wallet</title>
<style nonce="${nonce}">
  body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; display: grid; place-items: center; min-height: 100vh; margin: 0; }
  main { background: #1e293b; padding: 2rem; border-radius: 8px; max-width: 28rem; }
  code { display: block; background: #020617; padding: .5rem; margin: .75rem 0; word-break: break-all; }
  button { width: 100%; padding: .9rem; border: 0; border-radius: 6px; background: #2563eb; color: #fff; font-weight: 600; cursor: pointer; }
  button:disabled { background: #475569; cursor: default; }
  #status { margin-top: 1rem; color: #94a3b8; }
  a { color: #93c5fd; }
</style>
</head>
<body>
<main>
  <h2>Fund your agent wallet</h2>
  <p>Send <strong>${shown} NGT</strong> on Base to your agent wallet:</p>
  <code>${to}</code>
  <button id="send">Send ${shown} NGT with my browser wallet</button>
  <p id="status">Or send it from any wallet. Nothing moves until you confirm in your wallet.</p>
</main>
<script nonce="${nonce}">
  const TX = ${JSON.stringify(tx)};
  const BASE = ${JSON.stringify(BASE_CHAIN_ID)};
  const button = document.getElementById("send");
  const status = document.getElementById("status");
  button.onclick = async () => {
    const eth = window.ethereum;
    if (!eth) { status.textContent = "No browser wallet found. Send the NGT to the address above from any wallet."; return; }
    button.disabled = true;
    try {
      const [from] = await eth.request({ method: "eth_requestAccounts" });
      if ((await eth.request({ method: "eth_chainId" })) !== BASE) {
        status.textContent = "Switching your wallet to Base...";
        await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: BASE }] });
        if ((await eth.request({ method: "eth_chainId" })) !== BASE) throw new Error("your wallet is not on Base");
      }
      status.textContent = "Confirm the transfer in your wallet.";
      const hash = await eth.request({ method: "eth_sendTransaction", params: [{ ...TX, from }] });
      const link = document.createElement("a");
      link.href = "https://basescan.org/tx/" + hash;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "View on Basescan";
      status.replaceChildren("Sent. You can close this page. ", link);
    } catch (err) {
      status.textContent = "Not sent: " + (err && err.message ? err.message : String(err));
      button.disabled = false;
    }
  };
</script>
</body>
</html>
`;
}

/** Serves the funding page on 127.0.0.1 at a free port. */
export async function startFundingServer(to: `0x${string}`, amount: bigint): Promise<{ url: string; close: () => void }> {
  const nonce = randomBytes(16).toString("base64");
  const page = fundingPage(to, amount, nonce);
  const server = createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(page);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, close: () => server.close() };
}

export function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The URL is printed too, so a missing opener is not fatal.
  }
}

const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL) });

export function ngtBalance(address: `0x${string}`): Promise<bigint> {
  return client.readContract({ address: NGT_CONTRACT_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [address] });
}

/** USDC on Base, in its 6-decimal base units. */
export function usdcBalance(address: `0x${string}`): Promise<bigint> {
  return client.readContract({ address: ASSETS["eip155:8453"].USDC.address, abi: erc20Abi, functionName: "balanceOf", args: [address] });
}

/** Polls until the balance reaches `target`; resolves null if `stop` settles first or after 15 minutes. */
export async function waitForBalance(address: `0x${string}`, target: bigint, stop: Promise<unknown>): Promise<bigint | null> {
  let stopped = false;
  stop.then(
    () => (stopped = true),
    () => (stopped = true),
  );
  const deadline = Date.now() + 15 * 60_000;
  while (!stopped && Date.now() < deadline) {
    try {
      const balance = await ngtBalance(address);
      if (balance >= target) return balance;
    } catch {
      // Public RPCs rate-limit; try again on the next tick.
    }
    await Promise.race([new Promise((r) => setTimeout(r, 4000)), stop.catch(() => {})]);
  }
  return null;
}
