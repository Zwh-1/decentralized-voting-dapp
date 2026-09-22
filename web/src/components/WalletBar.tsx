import { useAccount, useChainId, useConnect, useDisconnect, useSwitchChain } from "wagmi";

import { useTranslator } from "@/components/LocaleProvider";
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
 *
 * ---------------------------------------------------------------------------
 * Why the colours here are not the shared tone tokens
 * ---------------------------------------------------------------------------
 *
 * This control sits in the dark masthead, on `slate-900`, where the light-theme
 * tokens are the wrong way round: `bg-emerald-50 text-emerald-700` is a pale
 * surface with dark text, which on a dark band reads as a hole rather than a
 * badge. So this file uses the translucent variants that are meant for dark
 * surfaces — `bg-emerald-500/15 text-emerald-300` and its amber counterpart.
 *
 * The states still mean the same thing, and they are the same two states: "the
 * wallet is on the chain this app is about" and "it is not". Only the rendering
 * differs, because only the surface differs.
 */
export function WalletBar({ configuredTarget }: { configuredTarget: ChainTarget | null }) {
  const translator = useTranslator();
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
            <span className="rounded-full bg-white/10 px-2.5 py-1 text-xs font-medium text-slate-300">
              {translator.t("wallet.pointsTo", {
                chainName: chainName(configuredTarget.chainId, translator.locale),
              })}
            </span>
          )}
          <button
            type="button"
            onClick={() => injected !== undefined && connect({ connector: injected })}
            disabled={isPending || injected === undefined}
            className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-400 disabled:bg-slate-600 disabled:text-slate-400"
          >
            {isPending ? translator.t("common.connecting") : translator.t("wallet.connect")}
          </button>
        </div>
        {error !== null && (
          /*
            `data-connect-error` is the stable hook the browser drill reads. It
            used to be found by its colour class (`.text-rose-600`), which broke
            the moment an unrelated element legitimately rendered in the same
            red — and the drill then reported the connect error as the text "否"
            from the whitelist row while blaming the wallet. A hook that names
            what it is cannot be matched by accident.
          */
          <p data-connect-error className="max-w-xs text-right text-xs text-rose-300">
            {error.message}
          </p>
        )}
      </div>
    );
  }

  const named =
    configuredTarget === null ? undefined : chainName(configuredTarget.chainId, translator.locale);
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
              ? "bg-amber-500/15 text-amber-300"
              : "bg-emerald-500/15 text-emerald-300"
          }`}
        >
          {chainName(chainId, translator.locale)}
        </span>
        <span className="rounded-lg bg-white/10 px-3 py-1.5 font-mono text-xs text-slate-200">
          {address === undefined ? "—" : shortenAddress(address)}
        </span>
        <button
          type="button"
          onClick={() => disconnect()}
          className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-slate-300 transition hover:bg-white/10"
        >
          {translator.t("wallet.disconnect")}
        </button>
      </div>

      {wrongChain && switchTarget !== undefined && named !== undefined && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-amber-300">
            {translator.t("wallet.notConnected", { chainName: named })}
          </span>
          <button
            type="button"
            onClick={() => switchChain({ chainId: switchTarget.id })}
            disabled={isSwitching}
            className="rounded-lg border border-amber-400/40 bg-amber-500/15 px-3 py-1 text-xs text-amber-200 transition hover:bg-amber-500/25 disabled:cursor-not-allowed"
          >
            {translator.t("wallet.switchTo", { chainName: named })}
          </button>
        </div>
      )}
    </div>
  );
}
