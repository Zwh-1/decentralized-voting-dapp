import { createConfig, fallback, http, type Transport } from "wagmi";
import { hardhat, sepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors";

import { resolveRpcEndpoints } from "./rpc-endpoints";

/**
 * wagmi configuration.
 *
 * Both chains are registered so the same build works against a local Hardhat
 * node and against Sepolia; the app reads the contract address for whichever
 * chain the wallet is on from `src/lib/contracts`, so switching networks needs no
 * rebuild.
 *
 * Both transports are configurable, and both had to be. The server's `RPC_URL` is
 * never visible to the browser, so the browser's own endpoint is a separate
 * setting — and without `NEXT_PUBLIC_SEPOLIA_RPC_URL` a Sepolia deployment could
 * only reach the RPC viem bundles for that chain, with no way to point it at an
 * endpoint that works from the reader's network. Like every `NEXT_PUBLIC_*`
 * value, these are inlined at build time: changing one needs a rebuild.
 *
 * ---------------------------------------------------------------------------
 * Why each variable is read twice
 * ---------------------------------------------------------------------------
 *
 * `NEXT_PUBLIC_X` is only replaced with its value when Next.js sees that exact
 * expression in the source. `process.env[name]` is NOT substituted — it survives
 * into the bundle as a runtime lookup of an object that does not exist in the
 * browser, and yields `undefined` for every endpoint. That failure is silent: the
 * app falls back to viem's built-in public RPC for the chain, which appears to
 * work, so the configured endpoint is never used and nothing says so.
 *
 * Hence the singular and plural variables are each referenced literally below,
 * and the generic parsing is done by a function that receives their VALUES rather
 * than reading the environment itself.
 */

/**
 * Builds a transport from one primary URL and any number of backups.
 *
 * The endpoint list comes from `resolveRpcEndpoints`, the same function the
 * server's `config.ts` uses, so a deployment configured identically on both sides
 * reads the same endpoints in the same order. Falling back to viem's default
 * transport when nothing is configured is what lets the Sepolia case work out of
 * the box while still allowing an override.
 */
function endpointTransport(primary: string | undefined, extra: string | undefined): Transport {
  const urls = resolveRpcEndpoints(primary, extra);

  if (urls.length === 0) {
    // viem's default for the chain. Not `http(undefined)`, which would silently
    // resolve to localhost.
    return http();
  }

  if (urls.length === 1) {
    return http(urls[0]);
  }

  // `rank: false` for the same reason as the server client: the order is the
  // operator's preference, and latency-ranking would let a public backup take
  // over from a paid primary because a ping happened to be faster.
  return fallback(
    urls.map((url) => http(url)),
    { rank: false },
  );
}

const localRpcUrl = process.env.NEXT_PUBLIC_LOCAL_RPC_URL ?? "http://127.0.0.1:8545";
const localRpcUrls = process.env.NEXT_PUBLIC_LOCAL_RPC_URLS;
const sepoliaRpcUrl = process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL;
const sepoliaRpcUrls = process.env.NEXT_PUBLIC_SEPOLIA_RPC_URLS;

export const wagmiConfig = createConfig({
  chains: [hardhat, sepolia],
  connectors: [injected()],
  transports: {
    [hardhat.id]: endpointTransport(localRpcUrl, localRpcUrls),
    [sepolia.id]: endpointTransport(sepoliaRpcUrl, sepoliaRpcUrls),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
