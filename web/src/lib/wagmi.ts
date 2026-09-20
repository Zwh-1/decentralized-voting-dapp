import { createConfig, http } from "wagmi";
import { hardhat, sepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors";

const localRpcUrl =
  (import.meta.env.VITE_LOCAL_RPC_URL as string | undefined) ?? "http://127.0.0.1:8545";

/**
 * wagmi configuration.
 *
 * Both chains are registered so the same build works against a local Hardhat
 * node and against Sepolia; the app reads the contract address for whichever
 * chain the wallet is on from `@voting/shared`, so switching networks needs no
 * rebuild.
 */
export const wagmiConfig = createConfig({
  chains: [hardhat, sepolia],
  connectors: [injected()],
  transports: {
    [hardhat.id]: http(localRpcUrl),
    [sepolia.id]: http(),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
