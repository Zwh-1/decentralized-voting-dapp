import { createConfig, http } from "wagmi";
import { hardhat, sepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors";

const localRpcUrl = process.env.NEXT_PUBLIC_LOCAL_RPC_URL ?? "http://127.0.0.1:8545";
const sepoliaRpcUrl = process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL;

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
 * value, this one is inlined at build time: changing it needs a rebuild.
 */
export const wagmiConfig = createConfig({
  chains: [hardhat, sepolia],
  connectors: [injected()],
  transports: {
    [hardhat.id]: http(localRpcUrl),
    [sepolia.id]:
      sepoliaRpcUrl === undefined || sepoliaRpcUrl.length === 0 ? http() : http(sepoliaRpcUrl),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
