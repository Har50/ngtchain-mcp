import assert from "node:assert/strict";
import test from "node:test";
import { verifyTypedData } from "viem";
import { executeNgtStream, explainSettlementError, NgtClientError, payAndFetch } from "../dist/index.js";

const asset = "0xc97b05F2F68D5CED7aB65F83ab5f4f7A64d9CC44";
const payTo = "0x675199F0b5F76f6b89D7B29c2ADf27C452E06784";
const key = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const nonce = `0x${"ab".repeat(32)}`;

function challenge(extra = { name: "NextGen Token", version: "1", nonce }) {
  return {
    x402Version: 2,
    accepts: [{
      scheme: "exact",
      network: "eip155:8453",
      amount: "1000000000000000",
      asset,
      payTo,
      maxTimeoutSeconds: 60,
      extra,
    }],
  };
}

test("a 402 challenge becomes a v2 PAYMENT-SIGNATURE and is not replayed here", async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    calls.push(init?.headers);
    if (calls.length === 1) {
      return new Response(JSON.stringify(challenge()), { status: 402, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ stream: "open" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await executeNgtStream(key, "https://example.test/v1/agent/stream");
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { stream: "open" });
    const encoded = calls[1]["PAYMENT-SIGNATURE"];
    const payment = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    assert.equal(payment.x402Version, 2);
    assert.equal(payment.payload.authorization.nonce, nonce);
    assert.equal(payment.payload.authorization.value, "1000000000000000");
    assert.equal(payment.payload.signature.length, 132);
    assert.equal(await verifyTypedData({
      address: payment.payload.authorization.from,
      signature: payment.payload.signature,
      domain: { name: "NextGen Token", version: "1", chainId: 8453, verifyingContract: asset },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: payment.payload.authorization.from,
        to: payTo,
        value: BigInt(payment.payload.authorization.value),
        validAfter: 0n,
        validBefore: BigInt(payment.payload.authorization.validBefore),
        nonce,
      },
    }), true);
  } finally {
    globalThis.fetch = original;
  }
});

test("the signed expiry stays inside the seller's window, so a fast clock still pays", async () => {
  const original = globalThis.fetch;
  for (const [window, expected] of [[60, 30], [10, 5], [600, 570]]) {
    const signed = [];
    globalThis.fetch = async (_url, init) => {
      if (!init?.headers?.["PAYMENT-SIGNATURE"]) {
        const body = challenge();
        body.accepts[0].maxTimeoutSeconds = window;
        return new Response(JSON.stringify(body), { status: 402, headers: { "content-type": "application/json" } });
      }
      signed.push(JSON.parse(Buffer.from(init.headers["PAYMENT-SIGNATURE"], "base64").toString("utf8")));
      return new Response(JSON.stringify({ stream: "open" }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const before = Math.floor(Date.now() / 1000);
      await executeNgtStream(key, "https://example.test/v1/agent/stream");
      const after = Math.floor(Date.now() / 1000);
      const validBefore = signed[0].payload.authorization.validBefore;
      assert.ok(validBefore >= before + expected && validBefore <= after + expected, `window ${window}: ${validBefore - before}s`);
    } finally {
      globalThis.fetch = original;
    }
  }
});

test("a challenge without a server nonce is rejected", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(challenge({})), { status: 402 });
  try {
    await assert.rejects(
      () => executeNgtStream(key, "https://example.test/v1/agent/stream"),
      (error) => error instanceof NgtClientError && /nonce/.test(error.message),
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("a challenge for the wrong asset is refused before signing", async () => {
  const original = globalThis.fetch;
  const body = challenge();
  body.accepts[0].asset = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 402 });
  try {
    await assert.rejects(
      () => executeNgtStream(key, "https://example.test/v1/agent/stream"),
      (error) => error instanceof NgtClientError && /asset/i.test(error.message),
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("a challenge above the stream price is refused before signing", async () => {
  const original = globalThis.fetch;
  const body = challenge();
  body.accepts[0].amount = "10000000000000000";
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 402 });
  try {
    await assert.rejects(
      () => executeNgtStream(key, "https://example.test/v1/agent/stream"),
      (error) => error instanceof NgtClientError && /amount/i.test(error.message),
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("a failed settlement response is thrown instead of returned as data", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify(challenge()), { status: 402, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "authorization has expired" }), {
      status: 402,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await assert.rejects(
      () => executeNgtStream(key, "https://example.test/v1/agent/stream"),
      (error) =>
        error instanceof NgtClientError
        && /settlement rejected/i.test(error.message)
        && /authorization has expired/.test(error.message),
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("known NGT settlement reverts become one actionable line", () => {
  const viemDump = 'The contract function "transferWithAuthorization" reverted with the following signature:\n0xe450d38c\n\nUnable to decode signature';
  assert.equal(explainSettlementError(viemDump), "wallet has insufficient NGT for this payment");
  assert.equal(
    explainSettlementError('reverted with the following reason:\nNGT: authorization expired'),
    "authorization expired before settlement; retry the call",
  );
  assert.equal(explainSettlementError("facilitator offline"), "facilitator offline");
});

test("known USDC settlement reverts become one actionable line", () => {
  assert.equal(
    explainSettlementError('reverted with the following reason:\nERC20: transfer amount exceeds balance'),
    "wallet has insufficient USDC for this payment",
  );
  assert.equal(explainSettlementError("reason: FiatTokenV2: invalid signature"), "signature does not match the paying wallet");
  assert.equal(explainSettlementError("Blacklistable: account is blacklisted"), "the USDC issuer has blocked a wallet in this payment");
});

function sellerFetch(sellerChallenge, paid = { quote: 42 }) {
  const seen = [];
  const fetch = async (_url, init) => {
    seen.push(init?.headers ?? {});
    if (!init?.headers?.["PAYMENT-SIGNATURE"]) {
      return new Response(JSON.stringify(sellerChallenge), { status: 402 });
    }
    const receipt = Buffer.from(JSON.stringify({ transaction: `0x${"cd".repeat(32)}` })).toString("base64");
    return new Response(JSON.stringify(paid), { status: 200, headers: { "payment-response": receipt } });
  };
  return { fetch, seen };
}

test("payAndFetch pays a third-party seller under the cap and reports the payment", async () => {
  const seller = "0x1111111111111111111111111111111111111111";
  const body = challenge();
  body.accepts[0].payTo = seller;
  body.accepts[0].amount = "2000000000000000";
  const original = globalThis.fetch;
  const fake = sellerFetch(body);
  globalThis.fetch = fake.fetch;
  try {
    const result = await payAndFetch(key, "https://seller.test/quote", { maxAmount: "0.005" });
    assert.equal(result.data.quote, 42);
    assert.deepEqual(result.payment, { amount: "0.002", asset: "NGT", payTo: seller, transaction: `0x${"cd".repeat(32)}` });
    assert.equal(fake.seen.length, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test("payAndFetch refuses a price above the cap before signing", async () => {
  const body = challenge();
  body.accepts[0].amount = "20000000000000000";
  const original = globalThis.fetch;
  const fake = sellerFetch(body);
  globalThis.fetch = fake.fetch;
  try {
    await assert.rejects(
      () => payAndFetch(key, "https://seller.test/quote", { maxAmount: "0.01" }),
      (error) => error instanceof NgtClientError && /0\.02 NGT; above the 0\.01 NGT cap/.test(error.message),
    );
    assert.equal(fake.seen.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("with redirect manual, a redirect fails the call and the headers never reach the other host", async () => {
  const { createServer } = await import("node:http");
  const otherHostHeaders = [];
  const other = createServer((req, res) => (otherHostHeaders.push(req.headers), res.end("{}")));
  await new Promise((resolve) => other.listen(0, "127.0.0.1", resolve));
  const seller = createServer((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${other.address().port}/steal` });
    res.end();
  });
  await new Promise((resolve) => seller.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(
      () => payAndFetch(key, `http://localhost:${seller.address().port}/quote`, {
        maxAmount: "0.01",
        headers: { "x-api-key": "secret" },
        redirect: "manual",
      }),
      (error) => error instanceof NgtClientError && /Unexpected status code: 302/.test(error.message),
    );
    assert.equal(otherHostHeaders.length, 0);
  } finally {
    seller.close();
    other.close();
  }
});

test("a non-JSON body is returned as text, free or paid, and a paid one keeps its payment", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("<html>free page</html>", { status: 200, headers: { "content-type": "text/html" } });
    const free = await payAndFetch(key, "https://seller.test/page", { maxAmount: "0.01" });
    assert.equal(free.data, "<html>free page</html>");
    assert.equal(free.payment, undefined);

    const seller = "0x1111111111111111111111111111111111111111";
    const body = challenge();
    body.accepts[0].payTo = seller;
    globalThis.fetch = async (_url, init) =>
      init?.headers?.["PAYMENT-SIGNATURE"]
        ? new Response("paid plain text", { status: 200 })
        : new Response(JSON.stringify(body), { status: 402 });
    const paid = await payAndFetch(key, "https://seller.test/report", { maxAmount: "0.01" });
    assert.equal(paid.data, "paid plain text");
    assert.equal(paid.payment.amount, "0.001");
    assert.equal(paid.payment.payTo, seller);
  } finally {
    globalThis.fetch = original;
  }
});

test("payAndFetch needs a real cap", async () => {
  await assert.rejects(() => payAndFetch(key, "https://seller.test/quote", { maxAmount: "0" }), /above zero/);
  await assert.rejects(() => payAndFetch(key, "https://seller.test/quote", { maxAmount: "lots" }), /not an NGT amount/);
});

test("payAndFetchWithSigner signs through an external wallet with the same caps", async () => {
  const { payAndFetchWithSigner } = await import("../dist/index.js");
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(key);
  const signed = [];
  const signer = { address: account.address, signTypedData: (td) => (signed.push(td), account.signTypedData(td)) };
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    calls.push(init?.headers);
    if (calls.length === 1) {
      return new Response(JSON.stringify(challenge()), { status: 402, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await assert.rejects(payAndFetchWithSigner(signer, "https://seller.test/q", { maxAmount: "0.0001" }), NgtClientError);
    assert.equal(signed.length, 0, "must not sign above the cap");
    calls.length = 0;
    const res = await payAndFetchWithSigner(signer, "https://seller.test/q", { maxAmount: "0.01" });
    assert.deepEqual(res.data, { ok: true });
    assert.equal(signed.length, 1);
    const payload = JSON.parse(Buffer.from(calls[1]["PAYMENT-SIGNATURE"], "base64").toString("utf8")).payload;
    assert.equal(payload.authorization.from, account.address);
    assert.ok(await verifyTypedData({ ...signed[0], address: account.address, signature: payload.signature }));
  } finally {
    globalThis.fetch = original;
  }
});

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const seller = "0x2222222222222222222222222222222222222222";
const NGT_DOMAIN = { name: "NextGen Token", version: "1", chainId: 8453, verifyingContract: asset };
const USDC_DOMAIN = { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC };

function entry(token, amount, extra = {}) {
  const isUsdc = token !== asset;
  return {
    scheme: "exact",
    network: "eip155:8453",
    amount,
    asset: token,
    payTo: seller,
    maxTimeoutSeconds: 60,
    extra: isUsdc ? { name: "USD Coin", version: "2", nonce, ...extra } : { name: "NextGen Token", version: "1", nonce, ...extra },
  };
}

/** A seller asking 0.001 NGT or 0.0025 USDC unless told otherwise. */
function both({ ngt = "1000000000000000", usdc = "2500" } = {}) {
  return { x402Version: 2, accepts: [entry(asset, ngt), entry(USDC, usdc)] };
}

async function pay(body, options) {
  const { payAndFetchWithSigner } = await import("../dist/index.js");
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(key);
  const signed = [];
  const signer = { address: account.address, signTypedData: (td) => (signed.push(td), account.signTypedData(td)) };
  const original = globalThis.fetch;
  const fake = sellerFetch(body);
  globalThis.fetch = fake.fetch;
  try {
    const outcome = await payAndFetchWithSigner(signer, "https://seller.test/q", options).then(
      (result) => ({ result }),
      (error) => ({ error }),
    );
    const header = fake.seen[1]?.["PAYMENT-SIGNATURE"];
    const sent = header ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) : undefined;
    return { ...outcome, signed, sent, requests: fake.seen.length, address: account.address };
  } finally {
    globalThis.fetch = original;
  }
}

function signedWith(run, domain) {
  const a = run.sent.payload.authorization;
  return verifyTypedData({
    address: run.address,
    signature: run.sent.payload.signature,
    domain,
    types: run.signed[0].types,
    primaryType: "TransferWithAuthorization",
    message: { from: a.from, to: a.to, value: BigInt(a.value), validAfter: 0n, validBefore: BigInt(a.validBefore), nonce: a.nonce },
  });
}

function refusedUnsigned(run, pattern) {
  assert.ok(run.error instanceof NgtClientError, `expected a refusal, got ${run.error ?? "a payment"}`);
  assert.match(run.error.message, pattern);
  assert.equal(run.signed.length, 0, "must not sign");
  assert.equal(run.requests, 1, "must not send a payment");
}

test("USDC is never paid without a USDC cap", async () => {
  refusedUnsigned(await pay({ x402Version: 2, accepts: [entry(USDC, "1")] }, { maxAmount: "1000" }), /expected NGT/);
  refusedUnsigned(await pay({ x402Version: 2, accepts: [entry(USDC, "1")] }, { caps: { NGT: "1000", USDC: "0" } }), /expected NGT/);
  const off = await pay(both(), { caps: { NGT: "0.01", USDC: "0" }, prefer: ["USDC"] });
  assert.equal(off.result.payment.asset, "NGT");
  refusedUnsigned(await pay(both({ ngt: "20000000000000000" }), { maxAmount: "0.01" }), /0\.02 NGT; above the 0\.01 NGT cap/);
});

test("with both tokens offered and capped, NGT is paid by default", async () => {
  const run = await pay(both(), { caps: { NGT: "0.01", USDC: "1" } });
  assert.deepEqual(run.result.payment, { amount: "0.001", asset: "NGT", payTo: seller, transaction: `0x${"cd".repeat(32)}` });
  assert.equal(run.sent.accepted.asset, asset);
  assert.equal(run.sent.payload.authorization.value, "1000000000000000");
  assert.equal(await signedWith(run, NGT_DOMAIN), true);
});

test("prefer USDC pays USDC, in USDC units, signed for the USDC contract", async () => {
  const run = await pay(both(), { caps: { NGT: "0.01", USDC: "1" }, prefer: ["USDC"] });
  assert.deepEqual(run.result.payment, { amount: "0.0025", asset: "USDC", payTo: seller, transaction: `0x${"cd".repeat(32)}` });
  assert.equal(run.sent.accepted.asset, USDC);
  assert.equal(run.sent.payload.authorization.value, "2500");
  assert.deepEqual(run.signed[0].domain, USDC_DOMAIN);
  assert.equal(await signedWith(run, USDC_DOMAIN), true);
  assert.equal(await signedWith(run, NGT_DOMAIN), false);
});

test("caps are separate: a token over its own cap falls back to the other, never to a converted cap", async () => {
  const ngtOver = await pay(both({ ngt: "20000000000000000" }), { caps: { NGT: "0.01", USDC: "1" } });
  assert.equal(ngtOver.result.payment.asset, "USDC");

  const usdcOver = await pay(both(), { caps: { NGT: "0.01", USDC: "0.002" }, prefer: ["USDC"] });
  assert.equal(usdcOver.result.payment.asset, "NGT");

  refusedUnsigned(
    await pay(both({ ngt: "20000000000000000" }), { caps: { NGT: "0.01", USDC: "0.002" }, prefer: ["USDC"] }),
    /0\.0025 USDC; above the 0\.002 USDC cap.*0\.02 NGT; above the 0\.01 NGT cap/,
  );
  refusedUnsigned(
    await pay({ x402Version: 2, accepts: [entry(USDC, "2500")] }, { caps: { NGT: "1000", USDC: "0.002" } }),
    /0\.0025 USDC; above the 0\.002 USDC cap/,
  );
  refusedUnsigned(await pay(both({ usdc: "3000000" }), { caps: { USDC: "2.5" } }), /3 USDC; above the 2\.5 USDC cap/);
});

test("a USDC offer with the wrong token domain is refused before signing", async () => {
  const caps = { caps: { USDC: "1" } };
  refusedUnsigned(await pay({ x402Version: 2, accepts: [entry(USDC, "2500", { name: "USDC" })] }, caps), /EIP-712 name USDC; expected USD Coin/);
  refusedUnsigned(await pay({ x402Version: 2, accepts: [entry(USDC, "2500", { version: "1" })] }, caps), /EIP-712 version 1; expected 2/);
  refusedUnsigned(await pay({ x402Version: 2, accepts: [entry(USDC_SEPOLIA, "2500")] }, caps), /expected USDC 0x8335/);
  const otherChain = entry(USDC, "2500");
  otherChain.network = "eip155:1";
  refusedUnsigned(await pay({ x402Version: 2, accepts: [otherChain] }, caps), /network eip155:1/);
});

test("Base Sepolia USDC is signed with its own name and chain id", async () => {
  const sepolia = { ...entry(USDC_SEPOLIA, "2500", { name: "USDC" }), network: "eip155:84532" };
  const run = await pay({ x402Version: 2, accepts: [sepolia] }, { caps: { USDC: "0.01" } });
  assert.equal(run.result.payment.asset, "USDC");
  const domain = { name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC_SEPOLIA };
  assert.deepEqual(run.signed[0].domain, domain);
  assert.equal(await signedWith(run, domain), true);
  assert.equal(await signedWith(run, { ...domain, chainId: 8453 }), false);
});

test("caps and preferences are validated before any request", async () => {
  const cases = [
    [{ caps: { USDC: "0.0000001" } }, /caps\.USDC 0\.0000001 is not a USDC amount/],
    [{ caps: { USDC: "-1" } }, /caps\.USDC must be above zero/],
    [{ caps: { NGT: "0", USDC: "0" } }, /no uncapped mode/],
    [{ maxAmount: "0.01", caps: { NGT: "0.01" } }, /maxAmount or caps\.NGT, not both/],
    [{ caps: { DAI: "1" } }, /only NGT and USDC/],
    [{}, /no uncapped mode/],
    [{ caps: {} }, /no uncapped mode/],
    [{ maxAmount: "0.01", prefer: ["DAI"] }, /unknown token DAI/],
    [{ maxAmount: "0.01", prefer: ["USDC", "USDC"] }, /prefer lists USDC twice/],
  ];
  for (const [options, pattern] of cases) {
    const run = await pay(both(), options);
    assert.ok(run.error instanceof NgtClientError, JSON.stringify(options));
    assert.match(run.error.message, pattern);
    assert.equal(run.requests, 0);
  }
});

test("executeNgtStream pays the NGT offer from a challenge that also lists USDC", async () => {
  const body = challenge();
  body.accepts.unshift({ ...entry(USDC, "1000"), payTo });
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    calls.push(init?.headers);
    return calls.length === 1
      ? new Response(JSON.stringify(body), { status: 402 })
      : new Response(JSON.stringify({ stream: "open" }), { status: 200 });
  };
  try {
    await executeNgtStream(key, "https://example.test/v1/agent/stream");
    const sent = JSON.parse(Buffer.from(calls[1]["PAYMENT-SIGNATURE"], "base64").toString("utf8"));
    assert.equal(sent.accepted.asset, asset);
    assert.equal(sent.payload.authorization.value, "1000000000000000");
  } finally {
    globalThis.fetch = original;
  }
});
