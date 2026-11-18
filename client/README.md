# `@ngtchain/client`

Pay x402-priced APIs from an agent or script on Base, in USDC or NGT, never above a cap you set per call. The client signs an EIP-3009 authorization locally; the seller's facilitator submits it and pays the gas, so the payer needs no ETH.

x402 is the open HTTP 402 payment standard published by Coinbase. This client works with x402 v2 sellers that use the `exact` scheme (EIP-3009 `transferWithAuthorization`) for NGT or USDC on Base, including servers built on [`@ngtchain/paywall`](https://www.npmjs.com/package/@ngtchain/paywall).

## Quickstart: your first paid call

1. **Install**

   ```bash
   npm install @ngtchain/client viem
   ```

2. **Fund a dedicated agent wallet** on Base with a little USDC (0.01 USDC covers ten demo calls). Use a fresh key that holds nothing else, and keep it in an environment variable, never in code.

3. **Pay for one call** to the NGT Chain demo endpoint (0.001 USDC, sample data):

   ```ts
   import { payAndFetch } from "@ngtchain/client";

   const res = await payAndFetch(process.env.AGENT_PRIVATE_KEY, "https://ngt-x-signal.onrender.com/api/v1/x-signal", {
     caps: { USDC: "0.001" }, // the most this call may cost
   });
   console.log(res.payment); // { amount: "0.001", asset: "USDC", payTo: "0x…", transaction: "0x…" }
   ```

   The transaction hash is a Base mainnet transfer you can open on Basescan. The demo server sleeps when idle, so the first call can take up to a minute.

If the seller asks for more than your cap, or for a token, address or network the client does not recognise, it throws an `NgtClientError` and signs nothing.

## Paying in NGT

```ts
const res = await payAndFetch(process.env.AGENT_PRIVATE_KEY, "https://api.example.com/v1/quote", {
  maxAmount: "0.01", // NGT; shorthand for caps.NGT
});
```

`executeNgtStream(privateKey)` makes one call to the NGT stream endpoint, `https://www.ngtchain.com/v1/agent/stream`, for 0.001 NGT. A second argument changes the URL, but it still pays only the NGT treasury; use `payAndFetch` for other sellers.

## Caps and token choice

```ts
const res = await payAndFetch(process.env.AGENT_PRIVATE_KEY, "https://api.example.com/v1/quote", {
  caps: { NGT: "0.01", USDC: "0.05" }, // per call, each in its own token
  // prefer: ["USDC"],                 // default order is NGT, then USDC
});
```

- Caps are per call and separate per token. Nothing is converted between tokens, and a token without a cap (or with a cap of `"0"`) is never paid. There is no uncapped mode.
- When the seller offers both tokens, the client pays the first token in `prefer` whose price fits its cap. If that price is above its cap, it tries the next token; if none fits, it refuses and signs nothing.
- `maxAmount` is shorthand for `caps.NGT`, so code written for 1.4 and earlier keeps paying NGT only. USDC needs a seller on `@ngtchain/paywall` 0.2.0 or later.
- A budget across many calls is up to the caller. [`@ngtchain/mcp`](https://www.npmjs.com/package/@ngtchain/mcp) adds a session budget for agents.
- A URL that answers 2xx without a 402 is returned free, with `payment` undefined; any other status throws `NgtClientError`. `data` is the parsed JSON body, or text when the body is not JSON (from 1.4.0; before that, a non-JSON body threw, even after payment).

| Network | Token | Address | EIP-712 name, version |
| --- | --- | --- | --- |
| Base (`eip155:8453`) | NGT | `0xc97b05F2F68D5CED7aB65F83ab5f4f7A64d9CC44` | NextGen Token, 1 |
| Base (`eip155:8453`) | USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | USD Coin, 2 |
| Base Sepolia (`eip155:84532`) | NGT | `0xc97b05F2F68D5CED7aB65F83ab5f4f7A64d9CC44` | NextGen Token, 1 |
| Base Sepolia (`eip155:84532`) | USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | USDC, 2 |

Token addresses and EIP-712 domains come from this table, never from the seller's challenge.

## Keys held in a wallet

`payAndFetchWithSigner(signer, url, options)` does the same with any signer that can sign typed data, so the key never has to be a string in your process.

## Options

Options also take `method`, `headers`, `body` and `redirect`. If `headers` carries a secret such as an API key, pass `redirect: "manual"`: Node's `fetch` keeps custom headers when it follows a redirect to another host, and with `"manual"` a redirect fails the call instead.

Source: [Har50/ngtchain-mcp](https://github.com/Har50/ngtchain-mcp). Homepage: [ngtchain.com](https://ngtchain.com).
