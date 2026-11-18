# `@ngtchain/mcp`

Stdio MCP server. Each call spends real NGT or USDC from a wallet you fund, within per-call caps and a session budget you set. The agent signs locally. The seller's facilitator pays Base gas.

The Claude Code plugin is the `ngtchain/` folder. That plugin takes the agent key from Claude Code's plugin settings (`userConfig`), not from an environment variable. The JSON later in this file is only for a manual install of the npm package. The `.mcpb` at the repository root, once packed, is for dragging into Claude Desktop. It is not part of the plugin folder.

## Tools

- `pay_and_fetch(url, max_price_ngt?, max_price_usdc?, method?, body?)` calls any API behind an NGT x402 paywall (for example one built with the `@ngtchain/paywall` npm package). It pays only NGT on Base, and only at or under the cap, unless you turn USDC on (see below). It returns the response, the amount and token paid, the seller wallet and the Base transaction.
- `fetch_ngt_stream` makes one call to the NGT stream endpoint for 0.001 NGT.
- `ngt_wallet_status` shows the agent wallet address, its NGT balance, the caps, the session budget left, and about how many 0.001 NGT calls the balance covers. With USDC on, it also shows the USDC balance, cap and budget left. It spends nothing.
- `fund_agent_wallet(amount_ngt)` opens a local page in your browser that asks your browser wallet to send that much NGT on Base to the agent wallet. Nothing moves until you confirm in your wallet, and the page never sees any key.

The server also gives the client instructions: check the wallet before the first paid call, point to `init` if no wallet is set up, and when the balance is low, propose an amount based on the calls planned. A 402 is the normal first step of a paid call and `pay_and_fetch` pays it; it is never a reason to fund. Each failure message says what to do next (for example: low balance, check the wallet and propose an amount; price above the cap, report it and do not retry). NGT cannot currently be bought; funding only moves NGT you already hold.

## API keys for paid APIs

Some paid APIs also need a key header. Set it per host in the server environment; the model never sees or chooses it:

```bash
NGT_HOST_HEADERS={"api.example.com":{"x-api-key":"..."}}
```

Headers go only to the exact host named (add `:port` for a non-default port). Requests to that host do not follow redirects, so a header never reaches another host. If the value is not valid, `pay_and_fetch` pays nothing until it is fixed. `ngt_wallet_status` lists the configured hosts and header names, never the values. In the Claude Desktop extension, use the optional "API key headers per host" setting; it takes the same JSON and is stored as a secret.

## Spending limits

| Variable | Default | Meaning |
|---|---|---|
| `NGT_MAX_PRICE` | `0.01` | Most one call may pay, in NGT. The tool's `max_price_ngt` can lower it, never raise it. |
| `NGT_SESSION_BUDGET` | `0.1` | Most `pay_and_fetch` may spend in total before the server restarts. |
| `NGT_MAX_FUNDING` | `10` | Most one `fund_agent_wallet` request may ask your browser wallet to send, in NGT. |

Only `https` URLs are paid (`http://localhost` is allowed for testing). Use a dedicated wallet that holds only the NGT you plan to spend.

## Paying in USDC (1.7.0, off by default)

Some sellers built on `@ngtchain/paywall` 0.2.0 also take USDC on Base. USDC is paid only when you set both of these above 0:

| Variable | Default | Meaning |
|---|---|---|
| `NGT_USDC_MAX_PRICE` | `0` | Most one call may pay, in USDC. The tool's `max_price_usdc` can lower it, never raise it. |
| `NGT_USDC_SESSION_BUDGET` | `0` | Most `pay_and_fetch` may spend in USDC before the server restarts. |
| `NGT_PREFERRED_CURRENCY` | `NGT` | Which token to pay when a seller takes both: `NGT` or `USDC`. |

- The NGT and USDC limits are separate. A USDC payment never uses the NGT budget, and nothing is converted between the two.
- When a seller takes both, the server pays NGT unless `NGT_PREFERRED_CURRENCY` is `USDC`. If the preferred token's price is above its cap or budget, it pays the other one if that fits.
- The token's contract and signing domain come from a fixed table in `@ngtchain/client` 1.5.0, never from the seller.
- `fund_agent_wallet` only sends NGT. Send USDC on Base to the agent wallet from your own wallet.
- `init` asks whether to turn USDC on. Running `init` again and answering no turns it off.
- In the Claude Desktop extension, use the optional USDC settings.

## See and stop spending

```bash
npx -y @ngtchain/mcp@1.7.1 dashboard   # local page: recent calls, totals, balances, pause button
npx -y @ngtchain/mcp@1.7.1 pause       # stop all agent spending, in every app
npx -y @ngtchain/mcp@1.7.1 resume      # allow it again
```

Every `pay_and_fetch` and `fetch_ngt_stream` call is recorded in `~/.ngtchain/activity.jsonl` (set `NGT_HOME` to use another folder): the time, the app, the host and path, the outcome (paid, free, refused, failed or paused), the amount and token, the seller wallet and the Base transaction. The dashboard's chart and main totals count NGT; USDC spending gets its own totals. It never records keys, header names or values, query strings, request bodies or response data. The log is capped at 1 MB; the oldest lines are dropped first.

While paused, both paid tools pay nothing and make no request, in every app that uses this machine's `~/.ngtchain`, including servers already running. `ngt_wallet_status` shows `paused`. No MCP tool can pause or resume; only you can, from the terminal or the dashboard.

The dashboard listens only on `127.0.0.1` at a random port, loads nothing from other sites, and accepts pause and resume only from its own page. It stops when you press Ctrl+C.

## Setup

```bash
npx -y @ngtchain/mcp@1.7.1 init
```

It asks which apps to configure (Cursor, Claude Desktop, Claude Code, Gemini CLI, Codex; pick one or several, like `1,3`), then for the agent wallet: paste a key (with or without `0x`; it is not shown) or press Enter to create a new wallet. It then asks for the two limits. It adds `ngtchain` to each app's MCP config and keeps your other servers and settings, including env vars you added to an existing `ngtchain` entry. It backs up the old file to `.bak` and refuses to touch a file it cannot parse (JSON, or TOML for Codex). It prints the wallet address, never the key.

| App | Config file |
|---|---|
| Cursor | `~/.cursor/mcp.json` |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` (Windows), `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) |
| Claude Code | `~/.claude.json` (user scope) |
| Gemini CLI | `~/.gemini/settings.json` |
| Codex | `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`) |

It then offers to fund the wallet. It opens a local page that asks your browser wallet to send NGT on Base to the agent address, and waits until the NGT arrives. The transfer is prepared by `init`, the page loads nothing from other sites, and the key never leaves the terminal. You can also skip this and send NGT to the address from any wallet.

To configure it by hand, set `NGT_AGENT_PRIVATE_KEY` in the MCP server environment. No tool accepts a private key as an argument.

In the Claude Desktop extension, set the agent key in the extension's settings. Pasting into that hidden field can add to the value already there rather than replace it, so clear the field first (or reinstall the extension) and paste the key once.

```json
{
  "mcpServers": {
    "ngtchain": {
      "command": "npx",
      "args": ["-y", "@ngtchain/mcp@1.7.1"],
      "env": {
        "NGT_AGENT_PRIVATE_KEY": "0x...",
        "NGT_MAX_PRICE": "0.01",
        "NGT_SESSION_BUDGET": "0.1"
      }
    }
  }
}
```

`npx -y @ngtchain/mcp@1.7.1` starts this version of the server. The source repository is [Har50/ngtchain-mcp](https://github.com/Har50/ngtchain-mcp). The homepage is [ngtchain.com](https://ngtchain.com). The registry name is `io.github.Har50/ngtchain`.
