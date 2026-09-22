import { useAccount, useChainId, useConnect, useDisconnect, useSwitchChain } from "wagmi";

import { CHAIN_NAMES, chainName, shortenAddress, type ChainTarget } from "../lib/voting";

/**
 * The wallet control, and which chain the page is about.
 *
 * When no wallet is connected there is still a chain that matters — the one the
 * server reads and this deployment is configured for — and the badge says so.
 * Previously the header said nothing about the chain until a wallet was
 * connected, so a reader had no way to see that the page was about Sepolia while
 * the rest of the page described the local contract.
 *
 * The switch control is offered whenever the wallet is on a chain other than the
 * configured one, not only when it is on a chain this project has a name for. A
 * wallet on Sepolia against a Sepolia deployment needs nothing, but a wallet on
 * the local chain against a Sepolia deployment needs to be told exactly that.
 */
export function WalletBar({ configuredTarget }: { configuredTarget: ChainTarget | null }) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connectors, connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { chains, switchChain, isPending: isSwitching } = useSwitchChain();

  if (!isConnected) {
    const injected = connectors[0];

    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-2">
          {configuredTarget !== null && (
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
              本应用指向 {chainName(configuredTarget.chainId)}
            </span>
          )}
          <button
            type="button"
            onClick={() => injected !== undefined && connect({ connector: injected })}
            disabled={isPending || injected === undefined}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:bg-slate-300"
          >
            {isPending ? "连接中…" : "连接钱包"}
          </button>
        </div>
        {error !== null && (
          <p className="max-w-xs text-right text-xs text-rose-600">{error.message}</p>
        )}
      </div>
    );
  }

  const named = configuredTarget === null ? undefined : chainName(configuredTarget.chainId);
  const wrongChain = configuredTarget !== null && chainId !== configuredTarget.chainId;
  // Narrowed to a chain this build can actually switch to: `switchChain` only
  // accepts an id the client config registers.
  const switchTarget =
    configuredTarget === null
      ? undefined
      : chains.find((chain) => chain.id === configuredTarget.chainId);
  const walletChainNamed = CHAIN_NAMES[chainId] !== undefined;

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-medium ${
            wrongChain || !walletChainNamed
              ? "bg-amber-50 text-amber-700"
              : "bg-emerald-50 text-emerald-700"
          }`}
        >
          {chainName(chainId)}
        </span>
        <span className="rounded-lg bg-slate-100 px-3 py-1.5 font-mono text-xs text-slate-700">
          {address === undefined ? "—" : shortenAddress(address)}
        </span>
        <button
          type="button"
          onClick={() => disconnect()}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 transition hover:bg-slate-50"
        >
          断开
        </button>
      </div>

      {wrongChain && switchTarget !== undefined && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-amber-700">本应用指向 {named}</span>
          <button
            type="button"
            onClick={() => switchChain({ chainId: switchTarget.id })}
            disabled={isSwitching}
            className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1 text-xs text-amber-800 transition hover:bg-amber-100 disabled:cursor-not-allowed"
          >
            切到{named}
          </button>
        </div>
      )}
    </div>
  );
}
