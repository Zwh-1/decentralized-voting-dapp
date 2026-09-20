import { useAccount, useChainId, useConnect, useDisconnect, useSwitchChain } from "wagmi";

import { shortenAddress } from "../lib/voting";

const CHAIN_NAMES: Record<number, string> = {
  31337: "本地 Hardhat",
  11155111: "Sepolia",
};

export function WalletBar() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connectors, connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: isSwitching } = useSwitchChain();

  if (!isConnected) {
    const injected = connectors[0];

    return (
      <div className="flex flex-col items-end gap-1">
        <button
          type="button"
          onClick={() => injected !== undefined && connect({ connector: injected })}
          disabled={isPending || injected === undefined}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:bg-slate-300"
        >
          {isPending ? "连接中…" : "连接钱包"}
        </button>
        {error !== null && (
          <p className="max-w-xs text-right text-xs text-rose-600">{error.message}</p>
        )}
      </div>
    );
  }

  const known = CHAIN_NAMES[chainId] !== undefined;

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-medium ${
            known ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
          }`}
        >
          {CHAIN_NAMES[chainId] ?? `未知链 ${chainId}`}
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

      {!known && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => switchChain({ chainId: 31337 })}
            disabled={isSwitching}
            className="rounded-lg border border-slate-200 px-3 py-1 text-xs text-slate-600 transition hover:bg-slate-50"
          >
            切到本地链
          </button>
          <button
            type="button"
            onClick={() => switchChain({ chainId: 11155111 })}
            disabled={isSwitching}
            className="rounded-lg border border-slate-200 px-3 py-1 text-xs text-slate-600 transition hover:bg-slate-50"
          >
            切到 Sepolia
          </button>
        </div>
      )}
    </div>
  );
}
