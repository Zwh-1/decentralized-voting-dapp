"use client";

import { useState } from "react";
import {
  useAccount,
  useChainId,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";

import { describeWriteFailure } from "@/lib/ballot-labels";
import {
  describeRevertData,
  executionStage,
  formatBps,
  outcomePresentation,
  quorumLabel,
  secondsUntilReady,
  shouldShowExecution,
  turnoutClearsQuorum,
  ZERO_ADDRESS,
} from "@/lib/governance";
import { Badge, Card, Row, Section, Skeleton } from "@/components/ui";
import { useMounted } from "@/hooks/useMounted";
import { pollAbi, resolveChainTarget } from "@/lib/voting";

/**
 * What a passed vote authorises, and how far it has got.
 *
 * ---------------------------------------------------------------------------
 * Why three buttons where the contract has three functions
 * ---------------------------------------------------------------------------
 *
 * `queueExecution`, `execute` and `cancelExecution` are each permissionless or
 * owner-only in a specific way, and the interface has to reflect that rather
 * than show all three to everyone:
 *
 *   * `queueExecution` and `execute` are PERMISSIONLESS. They are shown to any
 *     connected wallet, because a queue step only its creator can perform means
 *     a creator who dislikes the result can leave the vote without consequence.
 *   * `cancelExecution` is OWNER-ONLY. It is shown only to the creator, because
 *     it is the one step that can undo the vote's consequence and therefore the
 *     one step that must be attributable.
 *
 * The third case is `createPoll`-adjacent: the contract accepts a queue for a
 * target on a creation-time allowlist, and this panel does NOT offer a free-text
 * target field. An input that lets a user type an arbitrary address and then
 * reverts is worse than no input; the allowed list is displayed instead, and the
 * panel links to the contract for anything beyond that.
 */
type ExecutionTarget =
  | { kind: "queue"; target: `0x${string}`; value: bigint; data: `0x${string}` }
  | { kind: "execute" }
  | { kind: "cancel" };

export interface ExecutionPanelProps {
  /** The poll's address, from the route's `[id]` segment. */
  address: `0x${string}`;
  /** The chain and factory this deployment is configured for, or null. */
  configuredTarget: ReturnType<typeof resolveChainTarget>;
  /**
   * Which outcome the poll reached, as read by the page — or `undefined` to read
   * it here instead.
   *
   * Optional because the two callers differ. The ballot page has the verdict in
   * hand from its own server read, and passing it avoids a second round trip on
   * first paint. But this panel is ALSO the place a creator comes back to after
   * the vote closes, when the page's copy was rendered before that happened, so
   * it must be able to ask the chain itself rather than trust a possibly stale
   * prop. Providing `undefined` opts into the live read.
   */
  outcome?: number;
  /** The poll's creator, so the cancel control can be shown to them alone. */
  creator: `0x${string}`;
}

export function ExecutionPanel({
  address,
  configuredTarget,
  outcome: outcomeProp,
  creator,
}: ExecutionPanelProps) {
  const mounted = useMounted();
  const chainId = useChainId();
  const { address: account } = useAccount();

  const [written, setWritten] = useState<ExecutionTarget | null>(null);

  const governance = useReadContract({
    address,
    abi: pollAbi,
    functionName: "execution",
    query: { enabled: mounted && configuredTarget !== null },
  });

  // Read live only when the caller did not supply a verdict. `enabled` keeps the
  // hook from firing for callers that already know, so the prop is a real saving
  // rather than a decorative one.
  const liveOutcome = useReadContract({
    address,
    abi: pollAbi,
    functionName: "outcome",
    query: { enabled: mounted && configuredTarget !== null && outcomeProp === undefined },
  });

  const outcome = outcomeProp ?? (liveOutcome.data === undefined ? 0 : Number(liveOutcome.data));

  const targets = useReadContract({
    address,
    abi: pollAbi,
    functionName: "executionTargets",
    query: { enabled: mounted && configuredTarget !== null },
  });

  // The quorum and the turnout are read here rather than passed in, so that the
  // panel cannot be rendered with figures that disagree with the chain. They are
  // two fractions of the SAME frozen denominator, which is why they are read
  // together.
  const quorum = useReadContract({
    address,
    abi: pollAbi,
    functionName: "config",
    query: { enabled: mounted && configuredTarget !== null },
  });

  const turnout = useReadContract({
    address,
    abi: pollAbi,
    functionName: "turnoutBps",
    query: { enabled: mounted && configuredTarget !== null },
  });

  const { writeContract, data: hash, isPending, error } = useWriteContract();

  const receipt = useWaitForTransactionReceipt({ hash });

  const confirming = receipt.isLoading;
  const busy = isPending || confirming;

  // `execution()` is a struct getter, so it arrives as a tuple. Destructured
  // positionally, matching `readOnChainGovernance` in `chain.ts` — the two must
  // agree on the order, and the ABI is the shared source of that order.
  const queue = governance.data as
    readonly [`0x${string}`, bigint, `0x${string}`, bigint, `0x${string}`, boolean] | undefined;

  const target = queue?.[0] ?? ZERO_ADDRESS;
  const value = queue?.[1] ?? 0n;
  const calldata = queue?.[2] ?? "0x";
  const readyAt = queue?.[3] ?? 0n;
  const lastError = queue?.[4] ?? "0x";
  const done = queue?.[5] ?? false;

  const stage = executionStage({
    target,
    done,
    lastError,
    readyAt,
    now: Math.floor(Date.now() / 1000),
  });

  const presented = outcomePresentation(outcome);

  // `config()` is the struct getter, so the two governance fields are read
  // positionally. Same indices as `readOnChainGovernance` in `chain.ts`, which is
  // the reader this component duplicates for the live-update case; the ABI is the
  // shared source of the order.
  const configTuple = quorum.data as readonly unknown[] | undefined;
  const quorumBps = configTuple === undefined ? 0n : BigInt(configTuple[7] as bigint);
  const turnoutBps = (turnout.data as bigint | undefined) ?? 0n;
  const clears = turnoutClearsQuorum(turnoutBps, quorumBps);

  // While a live outcome read is in flight the verdict is genuinely unknown, and
  // `shouldShowExecution` would be answering a question it has not been told the
  // answer to. Rendering nothing during that window is correct only if nothing is
  // queued; a poll WITH a queue must not blink out of existence, so the queue
  // target — which is read independently — is allowed to keep it on screen.
  const outcomeUnknown = outcomeProp === undefined && liveOutcome.isLoading;

  if (!shouldShowExecution({ outcome, target }) && !outcomeUnknown) {
    return null;
  }

  const isCreator = account !== undefined && account.toLowerCase() === creator.toLowerCase();

  /**
   * Queues the poll's own `endPoll` as the demonstration action.
   *
   * Not a free-text target: see the note above. A poll calling itself is the
   * case the feature was built for and the only target guaranteed to be allowed
   * on every poll, so it is the one this panel offers.
   */
  function onQueueSelf(): void {
    setWritten({ kind: "queue", target: address, value: 0n, data: "0x" });

    writeContract({
      address,
      abi: pollAbi,
      functionName: "queueExecution",
      args: [address, 0n, "0x"],
      chainId,
    });
  }

  function onExecute(): void {
    setWritten({ kind: "execute" });

    writeContract({ address, abi: pollAbi, functionName: "execute", chainId });
  }

  function onCancel(): void {
    setWritten({ kind: "cancel" });

    writeContract({ address, abi: pollAbi, functionName: "cancelExecution", chainId });
  }

  const listedTargets = (targets.data as readonly `0x${string}`[] | undefined) ?? [];
  const writeFailure = error === null ? null : describeWriteFailure(error);

  return (
    <Section
      title="结果执行"
      description="A passed vote can authorise exactly one on-chain action. It waits out the timelock first, so voters can see what is about to happen."
    >
      <Card>
        <Row label="结果">
          {outcomeUnknown ? (
            <Skeleton className="h-5 w-28" />
          ) : (
            <Badge
              className={
                presented.tone === "pass"
                  ? "bg-emerald-50 text-emerald-700"
                  : presented.tone === "fail"
                    ? "bg-rose-50 text-rose-700"
                    : "bg-amber-50 text-amber-700"
              }
            >
              {presented.label}
            </Badge>
          )}
        </Row>

        {!outcomeUnknown && <Row label="说明">{presented.detail}</Row>}

        <Row label="法定人数">{quorumLabel(quorumBps)}</Row>
        <Row label="出席率">
          <span className={clears ? "" : "text-rose-700"}>
            {formatBps(turnoutBps)}
            {quorumBps === 0n ? "" : clears ? " — quorum met" : " — below quorum"}
          </span>
        </Row>

        {stage === "none" && !outcomeUnknown && (
          <Row label="队列">
            {outcome === 1 ? "Nothing queued yet." : "Only a passed vote can be queued."}
          </Row>
        )}

        {governance.isLoading && <Skeleton className="h-4 w-40" />}

        {stage !== "none" && (
          <>
            <Row label="目标">
              <span className="font-mono text-xs">{target}</span>
            </Row>

            <Row label="状态">
              {stage === "waiting" && (
                <span>
                  Waiting out the timelock —{" "}
                  {secondsUntilReady(readyAt, Math.floor(Date.now() / 1000))}s remaining.
                </span>
              )}
              {stage === "ready" && <span>Ready to execute now.</span>}
              {stage === "done" && <span>Executed.</span>}
              {stage === "failed" && (
                <span className="text-rose-700">
                  The last attempt reverted
                  {describeRevertData(lastError) === ""
                    ? "."
                    : `: ${describeRevertData(lastError)}`}
                  . The vote is unchanged and this can be retried.
                </span>
              )}
            </Row>

            {calldata !== "0x" && (
              <Row label="调用数据">
                <span className="font-mono text-xs break-all">{calldata}</span>
              </Row>
            )}
          </>
        )}

        <Row label="允许的目标">
          {listedTargets.length === 0 ? (
            <span>This poll itself only.</span>
          ) : (
            <ul className="space-y-1">
              {listedTargets.map((entry) => (
                <li key={entry} className="font-mono text-xs">
                  {entry}
                </li>
              ))}
            </ul>
          )}
        </Row>

        <div className="mt-4 flex flex-wrap gap-2">
          {stage === "none" && outcome === 1 && (
            <button
              type="button"
              onClick={onQueueSelf}
              disabled={busy || configuredTarget === null}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {written?.kind === "queue" && busy ? "Submitting…" : "Queue an action"}
            </button>
          )}

          {(stage === "waiting" || stage === "ready" || stage === "failed") && (
            <button
              type="button"
              onClick={onExecute}
              disabled={busy || stage === "waiting" || configuredTarget === null}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {written?.kind === "execute" && busy ? "Submitting…" : "Execute"}
            </button>
          )}

          {isCreator && stage !== "none" && stage !== "done" && (
            <button
              type="button"
              onClick={onCancel}
              disabled={busy || configuredTarget === null}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 disabled:opacity-50"
            >
              {written?.kind === "cancel" && busy ? "Submitting…" : "Cancel"}
            </button>
          )}
        </div>

        {writeFailure !== null && (
          <p
            className="mt-3 text-sm text-rose-700"
            data-write-error={writeFailure.classified ? "classified" : "unclassified"}
          >
            {writeFailure.text}
          </p>
        )}

        {hash !== undefined && <p className="mt-2 font-mono text-xs text-slate-500">{hash}</p>}
      </Card>
    </Section>
  );
}
