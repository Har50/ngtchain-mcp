// Manual check of init's browser funding step. Writes no config and needs no key, only the address to fund.
// Usage (after `npm run build`): node scripts/try-funding.mjs <agent address>
import { isAddress } from "viem";
import { fundFromBrowser, prompter } from "../dist/init.js";

const address = process.argv[2];
if (!address || !isAddress(address)) {
  console.log("Usage: node scripts/try-funding.mjs <agent address>   (the wallet that should receive the NGT)");
  process.exit(1);
}

const { ask, close } = prompter();
try {
  process.exitCode = (await fundFromBrowser(ask, address, "0.001")) ? 0 : 1;
} finally {
  close();
}
