import { privateKeyToAccount } from "viem/accounts";
import { formatUnits, isAddress, parseUnits, type Address, type Hex } from "viem";

export const NGT_CONTRACT_ADDRESS = "0xc97b05F2F68D5CED7aB65F83ab5f4f7A64d9CC44" as const;
export const NGT_TREASURY_ADDRESS = "0x675199F0b5F76f6b89D7B29c2ADf27C452E06784" as const;
export const DEFAULT_STREAM_URL = "https://www.ngtchain.com/v1/agent/stream";
/** Exact stream price: 0.001 NGT. */
export const NGT_STREAM_AMOUNT = "1000000000000000" as const;
export const ALLOWED_NETWORKS = ["eip155:8453", "eip155:84532"] as const;
/** How far inside the seller's maxTimeoutSeconds the signed expiry is set (at most half the window). */
export const CLOCK_MARGIN_SECONDS = 30;

export type PaymentAsset = "NGT" | "USDC";

export interface AssetInfo {
  symbol: PaymentAsset;
  address: Address;
  decimals: number;
  /** EIP-712 domain name and version of the token contract. */
  name: string;
  version: string;
}

const NGT_INFO = { symbol: "NGT", address: NGT_CONTRACT_ADDRESS, decimals: 18, name: "NextGen Token", version: "1" } as const;

/** The only tokens this client pays. Domains were read from the contracts on each network; challenges cannot override them. */
export const ASSETS: Record<(typeof ALLOWED_NETWORKS)[number], Record<PaymentAsset, AssetInfo>> = {
  "eip155:8453": {
    NGT: NGT_INFO,
    USDC: { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, name: "USD Coin", version: "2" },
  },
  "eip155:84532": {
    NGT: NGT_INFO,
    USDC: { symbol: "USDC", address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6, name: "USDC", version: "2" },
  },
};

const DECIMALS: Record<PaymentAsset, number> = { NGT: 18, USDC: 6 };
const DEFAULT_PREFERENCE: PaymentAsset[] = ["NGT", "USDC"];

export const TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface StreamResponse<T = unknown> {
  status: number;
  /** Parsed JSON body, or the body as text when it is not JSON. */
  data: T;
}

export interface AcceptedChallenge {
  scheme?: string;
  network?: string;
  amount?: string;
  asset?: Address;
  payTo?: Address;
  maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string; nonce?: Hex; assetTransferMethod?: string };
}

export class NgtClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NgtClientError";
  }
}

function normalizePrivateKey(value: string): Hex {
  const key = value.trim().replace(/^['"]|['"]$/g, "").replace(/\s+/g, "");
  const body = key.slice(0, 2).toLowerCase() === "0x" ? key.slice(2) : key;
  if (body.length === 40) throw new NgtClientError("agentPrivateKey is a wallet address.");
  if (body.length !== 64 || !/^[0-9a-fA-F]+$/.test(body)) {
    throw new NgtClientError("agentPrivateKey must be 64 hex characters.");
  }
  return `0x${body}`;
}

function chainIdFromNetwork(network: string | undefined): number {
  const match = /^eip155:(\d+)$/.exec(network ?? "");
  if (!match) throw new NgtClientError("x402 challenge network is not an eip155 chain.");
  return Number(match[1]);
}

/**
 * Refuse to sign a challenge that is not the pinned NGT stream price on Base.
 * Call this before EIP-712 signing so a hostile 402 cannot mint a blank-check authorization.
 */
export function validateAcceptedChallenge(accepted: AcceptedChallenge): void {
  if (accepted.scheme !== "exact") {
    throw new NgtClientError(`Refusing challenge scheme ${accepted.scheme ?? "(missing)"}; expected exact.`);
  }
  if (!accepted.network || !(ALLOWED_NETWORKS as readonly string[]).includes(accepted.network)) {
    throw new NgtClientError(
      `Refusing challenge network ${accepted.network ?? "(missing)"}; expected eip155:8453 or eip155:84532.`,
    );
  }
  if (accepted.asset?.toLowerCase() !== NGT_CONTRACT_ADDRESS.toLowerCase()) {
    throw new NgtClientError(
      `Refusing challenge asset ${accepted.asset ?? "(missing)"}; expected NGT ${NGT_CONTRACT_ADDRESS}.`,
    );
  }
  if (accepted.payTo?.toLowerCase() !== NGT_TREASURY_ADDRESS.toLowerCase()) {
    throw new NgtClientError(
      `Refusing challenge payTo ${accepted.payTo ?? "(missing)"}; expected treasury ${NGT_TREASURY_ADDRESS}.`,
    );
  }
  if (accepted.amount === undefined) {
    throw new NgtClientError("x402 challenge is missing accepts[0].amount.");
  }
  let requested: bigint;
  try {
    requested = BigInt(accepted.amount);
  } catch {
    throw new NgtClientError(`Refusing challenge amount ${accepted.amount}; not an integer.`);
  }
  if (requested !== BigInt(NGT_STREAM_AMOUNT)) {
    throw new NgtClientError(
      `Refusing challenge amount ${accepted.amount}; expected exact stream price ${NGT_STREAM_AMOUNT}.`,
    );
  }
  if (accepted.extra?.name && accepted.extra.name !== "NextGen Token") {
    throw new NgtClientError(`Refusing EIP-712 name ${accepted.extra.name}; expected NextGen Token.`);
  }
  if (accepted.extra?.version && accepted.extra.version !== "1") {
    throw new NgtClientError(`Refusing EIP-712 version ${accepted.extra.version}; expected 1.`);
  }
}

async function readErrorBody(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) return "(empty body)";
  try {
    const json = JSON.parse(text) as { error?: string; message?: string };
    if (typeof json.error === "string") return json.error;
    if (typeof json.message === "string") return json.message;
  } catch {
    // keep raw text
  }
  return text;
}

/** Parsed JSON, or the raw text when the body is not JSON (such as an HTML page). Never throws on content. */
async function readData<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

/**
 * Reverts transferWithAuthorization can produce: NGTToken's require strings and OpenZeppelin v5 custom errors,
 * then the require strings of Circle's FiatToken (USDC).
 */
const SETTLEMENT_REVERTS: ReadonlyArray<[match: string, meaning: string]> = [
  ["NGT: authorization not yet valid", "authorization is not valid yet (validAfter is in the future)"],
  ["NGT: authorization expired", "authorization expired before settlement; retry the call"],
  ["NGT: authorization already used", "this authorization nonce was already settled"],
  ["NGT: invalid authorization", "signature does not match the paying wallet"],
  ["0xe450d38c", "wallet has insufficient NGT for this payment"], // ERC20InsufficientBalance
  ["0x96c6fd1e", "paying wallet address is invalid"], // ERC20InvalidSender
  ["0xec442f05", "payee address is invalid"], // ERC20InvalidReceiver
  ["0xf645eedf", "signature is malformed"], // ECDSAInvalidSignature
  ["0xfce698f7", "signature has the wrong length"], // ECDSAInvalidSignatureLength
  ["0xd78bce0c", "signature has a non-canonical s value"], // ECDSAInvalidSignatureS
  ["FiatTokenV2: authorization is not yet valid", "authorization is not valid yet (validAfter is in the future)"],
  ["FiatTokenV2: authorization is expired", "authorization expired before settlement; retry the call"],
  ["FiatTokenV2: authorization is used or canceled", "this authorization nonce was already settled"],
  ["FiatTokenV2: invalid signature", "signature does not match the paying wallet"],
  ["transfer amount exceeds balance", "wallet has insufficient USDC for this payment"],
  ["Blacklistable: account is blacklisted", "the USDC issuer has blocked a wallet in this payment"],
  ["Pausable: paused", "the USDC contract is paused"],
];

/** Turn a facilitator error body into one line an agent can act on. Unknown errors pass through unchanged. */
export function explainSettlementError(detail: string): string {
  const lower = detail.toLowerCase();
  for (const [match, meaning] of SETTLEMENT_REVERTS) {
    if (lower.includes(match.toLowerCase())) return meaning;
  }
  return detail;
}

/**
 * Refuse any challenge that is not NGT on Base, or that asks for more than maxAmount (base units).
 * Unlike validateAcceptedChallenge, any payee is allowed: this is for paying third-party sellers.
 */
export function validateSellerChallenge(accepted: AcceptedChallenge, maxAmount: bigint): void {
  validateSellerAsset(accepted, "NGT", maxAmount);
}

/**
 * validateSellerChallenge for one named token: the asset must be that token's contract on the challenge's
 * network, the price at most `cap` in that token's own units, and any EIP-712 name and version must match ours.
 */
export function validateSellerAsset(accepted: AcceptedChallenge, symbol: PaymentAsset, cap: bigint): AssetInfo {
  if (accepted.scheme !== "exact") {
    throw new NgtClientError(`Refusing challenge scheme ${accepted.scheme ?? "(missing)"}; expected exact.`);
  }
  if (!accepted.network || !(ALLOWED_NETWORKS as readonly string[]).includes(accepted.network)) {
    throw new NgtClientError(`Refusing challenge network ${accepted.network ?? "(missing)"}; expected Base.`);
  }
  const info = ASSETS[accepted.network as (typeof ALLOWED_NETWORKS)[number]][symbol];
  if (accepted.asset?.toLowerCase() !== info.address.toLowerCase()) {
    throw new NgtClientError(`Refusing challenge asset ${accepted.asset ?? "(missing)"}; expected ${symbol} ${info.address}.`);
  }
  if (!accepted.payTo || !isAddress(accepted.payTo)) {
    throw new NgtClientError(`Refusing challenge payTo ${accepted.payTo ?? "(missing)"}; not an address.`);
  }
  let requested: bigint;
  try {
    requested = BigInt(accepted.amount ?? "");
  } catch {
    throw new NgtClientError(`Refusing challenge amount ${accepted.amount}; not an integer.`);
  }
  if (requested <= 0n) throw new NgtClientError("Refusing challenge amount; must be above zero.");
  if (requested > cap) {
    throw new NgtClientError(
      `Refusing to pay ${formatUnits(requested, info.decimals)} ${symbol}; above the ${formatUnits(cap, info.decimals)} ${symbol} cap.`,
    );
  }
  if (accepted.extra?.name && accepted.extra.name !== info.name) {
    throw new NgtClientError(`Refusing EIP-712 name ${accepted.extra.name}; expected ${info.name}.`);
  }
  if (accepted.extra?.version && accepted.extra.version !== info.version) {
    throw new NgtClientError(`Refusing EIP-712 version ${accepted.extra.version}; expected ${info.version}.`);
  }
  return info;
}

/** Which offered token to pay: the most preferred one with a cap whose price fits that cap. */
function chooseOffer(
  accepts: AcceptedChallenge[],
  caps: Map<PaymentAsset, bigint>,
  order: PaymentAsset[],
): { accepted: AcceptedChallenge; info: AssetInfo } {
  const refusals: string[] = [];
  for (const symbol of order) {
    const cap = caps.get(symbol);
    if (cap === undefined) continue;
    for (const accepted of accepts) {
      const network = accepted.network as (typeof ALLOWED_NETWORKS)[number];
      const address = ASSETS[network]?.[symbol]?.address;
      if (!address || accepted.asset?.toLowerCase() !== address.toLowerCase()) continue;
      try {
        return { accepted, info: validateSellerAsset(accepted, symbol, cap) };
      } catch (error) {
        refusals.push((error as Error).message);
      }
    }
  }
  if (refusals.length > 0) throw new NgtClientError(refusals.join(" "));
  // Nothing offered is a token we may pay: report why the first offer was refused.
  validateSellerAsset(accepts[0], order.find((symbol) => caps.has(symbol)) ?? "NGT", 0n);
  throw new NgtClientError("Refusing challenge; no offered token can be paid.");
}

function parseCaps(options: PayOptions): Map<PaymentAsset, bigint> {
  if (options.maxAmount !== undefined && options.caps?.NGT !== undefined) {
    throw new NgtClientError("Set maxAmount or caps.NGT, not both.");
  }
  const raw: Partial<Record<string, string>> = { ...options.caps };
  if (options.maxAmount !== undefined) raw.NGT = options.maxAmount;
  const caps = new Map<PaymentAsset, bigint>();
  for (const [symbol, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (symbol !== "NGT" && symbol !== "USDC") throw new NgtClientError(`caps.${symbol}: only NGT and USDC can be paid.`);
    const label = symbol === "NGT" && options.maxAmount !== undefined ? "maxAmount" : `caps.${symbol}`;
    let cap: bigint;
    try {
      if ((String(value).split(".")[1] ?? "").length > DECIMALS[symbol]) throw new Error("too many decimals");
      cap = parseUnits(value, DECIMALS[symbol]);
    } catch {
      throw new NgtClientError(`${label} ${value} is not ${symbol === "NGT" ? "an" : "a"} ${symbol} amount.`);
    }
    // A caps entry of 0 switches that token off; maxAmount 0 is still a mistake.
    if (cap === 0n && label !== "maxAmount") continue;
    if (cap <= 0n) throw new NgtClientError(`${label} must be above zero.`);
    caps.set(symbol, cap);
  }
  if (caps.size === 0) throw new NgtClientError("maxAmount (or caps) is required: there is no uncapped mode.");
  return caps;
}

function preferenceOrder(prefer: PaymentAsset[] | undefined): PaymentAsset[] {
  if (prefer === undefined) return DEFAULT_PREFERENCE;
  const order: PaymentAsset[] = [];
  for (const symbol of prefer) {
    if (symbol !== "NGT" && symbol !== "USDC") throw new NgtClientError(`prefer: unknown token ${symbol}; use NGT or USDC.`);
    if (order.includes(symbol)) throw new NgtClientError(`prefer lists ${symbol} twice.`);
    order.push(symbol);
  }
  return [...order, ...DEFAULT_PREFERENCE.filter((symbol) => !order.includes(symbol))];
}

export interface PayOptions {
  /** Most this call may spend, in NGT, e.g. "0.01". Set this or `caps`: there is no uncapped mode. */
  maxAmount?: string;
  /**
   * Per-token caps for this call, e.g. { NGT: "0.01", USDC: "0.05" }. A token without a cap is never paid,
   * so USDC is only paid when caps.USDC is set. Caps are separate: nothing is converted between tokens.
   */
  caps?: Partial<Record<PaymentAsset, string>>;
  /** When a seller offers several tokens, try them in this order. Default NGT, then USDC. */
  prefer?: PaymentAsset[];
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Redirect mode for both requests. Use "manual" when headers must not reach another host: a redirect then fails the call. */
  redirect?: RequestRedirect;
}

export interface Payment {
  /** In the paid token's own units. */
  amount: string;
  asset: PaymentAsset;
  payTo: Address;
  /** Base tx hash from the seller's PAYMENT-RESPONSE header, when sent. */
  transaction?: string;
}

export interface PaidResponse<T = unknown> extends StreamResponse<T> {
  /** Undefined when the endpoint answered without asking for payment. */
  payment?: Payment;
}

/**
 * Fetch any x402 v2 NGT-paywalled URL. Pays only NGT on Base, only up to maxAmount, unless caps.USDC
 * is set; then USDC can be paid too, up to that cap. The caller signs locally; the seller's facilitator
 * submits the transfer and pays gas.
 */
export async function payAndFetch<T = unknown>(
  agentPrivateKey: string,
  url: string,
  options: PayOptions,
): Promise<PaidResponse<T>> {
  return payAndFetchWithSigner<T>(privateKeyToAccount(normalizePrivateKey(agentPrivateKey)), url, options);
}

/**
 * Something that can sign EIP-712 typed data for one address, such as a viem account
 * or an AgentKit EvmWalletProvider wrapped with { address, signTypedData }.
 */
export interface NgtSigner {
  address: Address;
  signTypedData(typedData: {
    domain: { name: string; version: string; chainId: number; verifyingContract: Address };
    types: typeof TRANSFER_TYPES;
    primaryType: "TransferWithAuthorization";
    message: {
      from: Address;
      to: Address;
      value: bigint;
      validAfter: bigint;
      validBefore: bigint;
      nonce: Hex;
    };
  }): Promise<Hex>;
}

/** payAndFetch for callers whose key lives in a wallet, not in a string. Same checks and caps. */
export async function payAndFetchWithSigner<T = unknown>(
  signer: NgtSigner,
  url: string,
  options: PayOptions,
): Promise<PaidResponse<T>> {
  const caps = parseCaps(options);
  const order = preferenceOrder(options.prefer);
  return payChallenge<T>(signer, url, options, (accepts) => chooseOffer(accepts, caps, order));
}

/**
 * One x402 v2 stream call. The caller signs locally. The facilitator submits the transfer and pays Base gas.
 * @param agentPrivateKey Private key of the wallet that holds NGT.
 * @param endpointUrl Stream URL. Defaults to the public NGT endpoint.
 */
export async function executeNgtStream<T = unknown>(
  agentPrivateKey: string,
  endpointUrl: string = DEFAULT_STREAM_URL,
): Promise<StreamResponse<T>> {
  const account = privateKeyToAccount(normalizePrivateKey(agentPrivateKey));
  const { status, data } = await payChallenge<T>(account, endpointUrl, {}, (accepts) => {
    const accepted = accepts.find((a) => a.asset?.toLowerCase() === NGT_CONTRACT_ADDRESS.toLowerCase()) ?? accepts[0];
    validateAcceptedChallenge(accepted);
    return { accepted, info: NGT_INFO };
  });
  return { status, data };
}

async function payChallenge<T>(
  account: NgtSigner,
  endpointUrl: string,
  request: Pick<PayOptions, "method" | "headers" | "body" | "redirect">,
  choose: (accepts: AcceptedChallenge[]) => { accepted: AcceptedChallenge; info: AssetInfo },
): Promise<PaidResponse<T>> {
  const init = { method: request.method, body: request.body, headers: request.headers, redirect: request.redirect };

  const challengeRes = await fetch(endpointUrl, init);
  if (challengeRes.status !== 402) {
    if (challengeRes.ok) {
      return { status: challengeRes.status, data: await readData<T>(challengeRes) };
    }
    throw new NgtClientError(
      `Unexpected status code: ${challengeRes.status}: ${await readErrorBody(challengeRes)}`,
    );
  }

  const challenge = (await challengeRes.json()) as { x402Version?: number; accepts?: AcceptedChallenge[] };
  const accepts = Array.isArray(challenge.accepts) ? challenge.accepts.filter((a) => a && typeof a === "object") : [];
  if (accepts.length === 0) throw new NgtClientError("Invalid x402 challenge: missing accepts[0].");
  const { accepted, info } = choose(accepts);
  const nonce = accepted.extra?.nonce;
  const payTo = accepted.payTo;
  const amount = accepted.amount;
  const windowSeconds = accepted.maxTimeoutSeconds;
  if (!payTo || amount === undefined) throw new NgtClientError("Invalid x402 challenge: missing payTo or amount.");
  if (!nonce) throw new NgtClientError("x402 challenge is missing accepts[0].extra.nonce.");
  if (windowSeconds === undefined || !Number.isInteger(windowSeconds) || windowSeconds <= 0) {
    throw new NgtClientError("x402 challenge is missing maxTimeoutSeconds.");
  }

  // Sellers reject an expiry past their own clock + window, so stay inside it: a fast local clock still pays.
  const validBefore = Math.floor(Date.now() / 1000) + windowSeconds - Math.min(CLOCK_MARGIN_SECONDS, Math.floor(windowSeconds / 2));
  const signature = await account.signTypedData({
    domain: {
      name: info.name,
      version: info.version,
      chainId: chainIdFromNetwork(accepted.network),
      verifyingContract: info.address,
    },
    types: TRANSFER_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: account.address,
      to: payTo,
      value: BigInt(amount),
      validAfter: 0n,
      validBefore: BigInt(validBefore),
      nonce,
    },
  });

  const paymentHeader = Buffer.from(JSON.stringify({
    x402Version: challenge.x402Version ?? 2,
    accepted,
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: payTo,
        value: String(amount),
        validAfter: 0,
        validBefore,
        nonce,
      },
    },
  })).toString("base64");

  const streamRes = await fetch(endpointUrl, {
    ...init,
    headers: { ...request.headers, "PAYMENT-SIGNATURE": paymentHeader },
  });
  if (!streamRes.ok) {
    throw new NgtClientError(
      `Stream settlement rejected (HTTP ${streamRes.status}): ${explainSettlementError(await readErrorBody(streamRes))}`,
    );
  }
  let transaction: string | undefined;
  try {
    const receipt = streamRes.headers.get("payment-response");
    if (receipt) transaction = JSON.parse(Buffer.from(receipt, "base64").toString("utf8")).transaction;
  } catch {
    // receipt header is optional
  }
  return {
    status: streamRes.status,
    data: await readData<T>(streamRes),
    payment: { amount: formatUnits(BigInt(amount), info.decimals), asset: info.symbol, payTo, transaction },
  };
}
