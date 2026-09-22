import { createConfig, fallback, http, type CreateConnectorFn, type Transport } from "wagmi";
import { hardhat, sepolia } from "wagmi/chains";
import { coinbaseWallet, injected, walletConnect } from "wagmi/connectors";

import { resolveRpcEndpoints } from "./rpc-endpoints";
import { WALLET_APP_NAME, resolveWalletConnect, walletConnectNotice } from "./wallet-connectors";

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

/**
 * Read literally, for the same inlining reason as the endpoints above.
 *
 * `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` is a public value by design — it ships in
 * the client bundle — so it is configuration, not a secret. It is still not
 * committed, because it is per-deployment and belongs in `web/.env` with the rest.
 */
const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

const walletConnectStatus = resolveWalletConnect(walletConnectProjectId);
const walletConnectWarning = walletConnectNotice(walletConnectStatus);

if (walletConnectWarning !== null && typeof window !== "undefined") {
  /*
    `info`, not `warn`, and the level is load-bearing rather than cosmetic.

    This fires on EVERY page load in EVERY reader's browser, and what it reports
    is that one optional extra connector is not offered — not that anything is
    broken. A desktop reader with an injected wallet has lost nothing at all.

    `ui-drill` asserts that the page logs nothing above info level, because its
    job is to catch defects the DOM cannot show (a hydration mismatch still
    renders a correct-looking page). Marking a deliberate configuration notice as
    a warning makes that assertion fail for a non-defect, which would train the
    next person to loosen the assertion — and then it stops catching the real
    thing. Measured: at `warn` the drill reported "1 failure(s)" naming only this
    message.
  */
  console.info(walletConnectWarning);
}

/**
 * The connectors, in the order a wallet picker should show them.
 *
 * `injected()` first because it is the one that works with no configuration and no
 * relay — a desktop extension or a wallet's own in-app browser connects straight
 * through it. WalletConnect is added only when configured (see
 * `wallet-connectors.ts` for why an unconfigured one is omitted rather than
 * broken). Coinbase Wallet last: it needs no project id, and it covers readers who
 * use that wallet on a phone, but it is the narrowest of the three.
 *
 * `appName` is the only parameter. The v4 SDK takes `{ appName, appLogoUrl? }` at
 * construction and chooses between the smart wallet and the extension itself, so
 * there is no preference to express here — an earlier version of this file passed
 * a `preference` string, which the current SDK does not accept at this layer and
 * which failed to typecheck.
 */
function buildConnectors(): CreateConnectorFn[] {
  const connectors: CreateConnectorFn[] = [injected()];

  if (walletConnectStatus.available) {
    connectors.push(
      walletConnect({
        projectId: walletConnectStatus.projectId,
        showQrModal: true,
        metadata: {
          name: WALLET_APP_NAME,
          description: "On-chain voting with on-chain tallies.",
          url: "https://localhost",
          icons: [],
        },
      }),
    );
  }

  connectors.push(coinbaseWallet({ appName: WALLET_APP_NAME }));

  return connectors;
}

export const wagmiConfig = createConfig({
  chains: [hardhat, sepolia],
  connectors: buildConnectors(),
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
