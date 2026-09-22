"use client";

import { useEffect, useRef, useState } from "react";
import {
  useAccount,
  useChainId,
  useConfig,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";

import { TemplatePicker } from "@/components/TemplatePicker";
import { useTranslator } from "@/components/LocaleProvider";
import { useMounted } from "@/hooks/useMounted";
import { describeWriteFailure } from "@/lib/ballot-labels";
import {
  createDraftStore,
  draftBoolean,
  draftStorage,
  draftString,
  draftStringArray,
  type Draft,
} from "@/lib/draft";
import { isPlausibleCid } from "@/lib/ipfs";
import type { PollConfig } from "@/lib/mechanisms";
import {
  DEFAULT_TEMPLATE,
  buildPollConfig,
  describeConfigProblem,
  describeMechanisms,
  findTemplate,
  type PollTemplate,
} from "@/lib/templates";
import { chainName, factoryAbi, resolveChainTarget, type ChainTarget } from "@/lib/voting";

/** The fewest options `Poll.MIN_OPTIONS` accepts. A poll with fewer reverts. */
const MIN_OPTIONS = 2;

/** What `new Date(value).getTime()` returns for an empty or unparseable value. */
const INVALID_DATE = Number.NaN;

/**
 * The template the form's config starts from, before the reader picks one.
 *
 * `DEFAULT_TEMPLATE` comes from `templates.ts` rather than a literal id here:
 * an id written down twice is an id that can be renamed once, and the failure
 * would land on the form's first render only.
 */
const DEFAULT_TEMPLATE_ID = DEFAULT_TEMPLATE.id;

/** How long typing pauses before the draft is written, in milliseconds. */
const DRAFT_SAVE_DELAY_MS = 400;

/**
 * How the form's state maps onto the draft.
 *
 * `templateId` is stored as the template's id rather than as the nine config
 * fields, so the config is rebuilt from `templates.ts` on restore and a template
 * whose defaults change does not leave an old copy of itself in a reader's
 * browser. Changing what one of these keys means requires bumping
 * `DRAFT_VERSION` in `draft.ts`.
 */
const DRAFT_FIELD_QUESTION = "question";
const DRAFT_FIELD_OPTIONS = "options";
const DRAFT_FIELD_DEADLINE = "deadline";
const DRAFT_FIELD_ADMISSION = "openToAll";
const DRAFT_FIELD_TEMPLATE = "templateId";

export interface CreatePollFormProps {
  configuredTarget: ChainTarget | null;
}

/**
 * Create a poll, signed by the reader's own wallet.
 *
 * The backend holds no private key (ADR-0001 / D6), and this form is where that
 * matters most: `createPoll` deploys a clone and initialises it, and the caller
 * becomes the poll's owner — the one address that may manage its whitelist and
 * end it. That signature can only come from the reader, so this is a direct
 * wallet write and never a server call.
 *
 * **What is stored, honestly.** The contract takes `string[] optionCIDs`, but
 * nothing on chain checks that a string *is* a CID: it is stored verbatim, in
 * storage that is immutable after creation. So this form accepts either and says
 * which one it is registering, per option:
 *
 *   * a value that parses as an IPFS CID is registered as a metadata CID, and the
 *     document is fetched from a gateway by everyone who opens the poll;
 *   * anything else is registered as the option's literal text. The poll still
 *     works — votes are counted by id — but there is no document, and whoever
 *     reads the poll later sees exactly that string.
 *
 * Saying which of the two is about to be written, before the transaction, is the
 * whole point of the hint under the field. The old ballot's failure was a seeded
 * `bafyseededcandidate0` sitting in immutable storage that nothing could correct;
 * the fix is not to pretend the chain validates, it is to tell the reader what
 * they are about to make permanent.
 */
export function CreatePollForm({ configuredTarget }: CreatePollFormProps) {
  const { t, ballot, locale } = useTranslator();
  const mounted = useMounted();
  const config = useConfig();
  const { address, isConnected } = useAccount();
  const walletChainId = useChainId();

  const target = resolveChainTarget({
    walletConnected: isConnected,
    walletChainId,
    configured: configuredTarget,
  });
  const targetChain =
    target === null ? undefined : config.chains.find((chain) => chain.id === target.chainId);
  const factoryKnown = target !== null && targetChain !== undefined;

  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  // Whether the panel is open. Closed by default so the poll list owns the
  // page's vertical space; see the header's comment for why the form is hidden
  // rather than unmounted when it closes.
  const [expanded, setExpanded] = useState(false);
  // A local `datetime-local` value, e.g. "2026-10-01T12:00". Interpreted in the
  // browser's timezone, which is the only timezone the reader can reason about.
  const [deadline, setDeadline] = useState("");
  // Who may vote. Defaults to the open option because the whitelist path makes
  // the poll unusable until the creator remembers to add addresses, and a poll
  // nobody can vote in is the failure this whole feature exists to remove.
  const [openToAll, setOpenToAll] = useState(true);
  // Which template's mechanism config the form is using. `null` means the
  // contract defaults, which is the state the form has always had.
  const [templateId, setTemplateId] = useState<string | null>(null);
  // Whether a draft was found and put back into the fields on mount. Drives one
  // sentence, once — after the reader edits anything it is no longer news.
  const [draftRestored, setDraftRestored] = useState(false);
  // The last autosave outcome, or `null` when there is nothing to report. `false`
  // is the case that matters: the values are NOT saved, and the form says so
  // rather than showing a "已保存" line over storage that refused the write.
  const [draftSaved, setDraftSaved] = useState<boolean | null>(null);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { writeContract, data: hash, isPending, error: writeError, reset } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash });
  const txBusy = isPending || receipt.isLoading;

  const writeFailure = writeError === null ? null : describeWriteFailure(writeError);

  useEffect(() => {
    if (writeError !== null && writeFailure?.classified === false) {
      console.error("createPoll failed with an unclassified error", writeError);
    }
  }, [writeError, writeFailure]);

  // A failure must never be hidden behind a collapsed panel. The only way a
  // write error can exist is that the reader submitted, which means they had the
  // panel open — but the panel could have been closed again while the wallet
  // prompt was up, and a rejected transaction that silently does nothing is the
  // worst outcome this form can produce.
  useEffect(() => {
    if (writeError !== null) {
      setExpanded(true);
    }
  }, [writeError]);

  useEffect(() => {
    if (!receipt.isSuccess) {
      return;
    }

    // The poll exists now. Clearing the form is not cosmetic: leaving the values
    // in place invites a second identical transaction, and `createPoll` has no
    // idempotency — it would deploy a second poll with the same question.
    setQuestion("");
    setOptions(["", ""]);
    setDeadline("");
    // Reset to the open default rather than to whatever was last submitted: the
    // next poll should start from the choice that cannot strand it.
    setOpenToAll(true);
    setTemplateId(null);

    // The draft is cleared here and only here — on a confirmed receipt. A failed
    // or rejected transaction leaves the form exactly as it was, and a reader who
    // has to retype a question because their wallet refused the first attempt has
    // lost work to the feature that exists to stop that. `setDraftSaved(null)`
    // drops the "已保存" line rather than announcing a save the autosave effect is
    // about to make impossible: the fields it would save are now empty.
    createDraftStore(draftStorage()).clear();
    setDraftSaved(null);
    setDraftRestored(false);

    reset();
  }, [receipt.isSuccess, reset]);

  /*
    Restoring the draft, once, on mount.

    In an effect rather than in `useState` initialisers because `localStorage`
    does not exist during server rendering: a value read at render time would
    differ between the server HTML and the client's first render, which is a
    hydration mismatch. Running after mount means the first render is the same
    empty form on both sides, and the restored values arrive as an ordinary
    state update.

    A value is read per field: a draft that passes `readDraft`'s shape check can
    still be missing a field (it is written field by field), and every getter
    answers `null` for that rather than handing back a wrong-typed value.
  */
  useEffect(() => {
    const stored: Draft | null = createDraftStore(draftStorage()).read().draft;

    if (stored === null) {
      return;
    }

    const restoredQuestion = draftString(stored, DRAFT_FIELD_QUESTION);
    const restoredOptions = draftStringArray(stored, DRAFT_FIELD_OPTIONS);
    const restoredDeadline = draftString(stored, DRAFT_FIELD_DEADLINE);
    const restoredAdmission = draftBoolean(stored, DRAFT_FIELD_ADMISSION);
    const restoredTemplate = draftString(stored, DRAFT_FIELD_TEMPLATE);

    // A draft has to carry at least one thing worth restoring. An empty one —
    // every field still at its default — is indistinguishable from no draft, and
    // restoring it would tell the reader a draft was found and then show them
    // nothing. A chosen template counts on its own: a reader who picked 加权 and
    // had not typed yet has made a decision the form must not forget, and the
    // text fields being empty is exactly what that looks like.
    if (
      restoredQuestion === null &&
      restoredOptions === null &&
      restoredDeadline === null &&
      restoredTemplate === null
    ) {
      return;
    }

    if (restoredQuestion !== null) setQuestion(restoredQuestion);
    if (restoredDeadline !== null) setDeadline(restoredDeadline);
    if (restoredAdmission !== null) setOpenToAll(restoredAdmission);

    if (restoredOptions !== null && restoredOptions.length >= MIN_OPTIONS) {
      setOptions(restoredOptions);
    } else if (restoredOptions !== null && restoredOptions.length > 0) {
      // The form cannot render fewer rows than the contract's minimum, so a
      // short list is padded rather than rejected: the values that were saved
      // are kept, and the missing rows come back empty.
      setOptions([...restoredOptions, ...Array(MIN_OPTIONS - restoredOptions.length).fill("")]);
    }

    // A template id this build no longer knows is dropped, not guessed at: the
    // alternative is picking a template at random and creating a poll with
    // mechanisms the reader never saw.
    if (restoredTemplate !== null && findTemplate(restoredTemplate) !== null) {
      setTemplateId(restoredTemplate);
    }

    setDraftRestored(true);
    // A found draft is by definition already stored. Saying so is the honest
    // report; it does NOT claim a new write happened.
    setDraftSaved(true);

    // The panel opens itself, for the same reason it opens on a failed write: a
    // restored draft behind a collapsed header is a form the reader cannot see,
    // and the sentence saying a draft came back would be invisible inside it.
    setExpanded(true);
  }, []);

  /*
    Autosaving, debounced.

    The draft is written while the reader types, not when the tab is closed:
    `beforeunload` does not fire on a crash or a mobile tab eviction, and those
    are the reloads that actually lose work. Writing on every keystroke would hit
    the storage quota with intermediate values nobody wants, so a pause of
    `DRAFT_SAVE_DELAY_MS` sets the boundary.

    `saveDraft` returns whether the write happened. That boolean is the whole
    reason `draftSaved` can be trusted: storage that throws (private browsing,
    disabled cookies, a full quota) reports `false`, and the form then tells the
    reader their draft is NOT kept instead of showing a saved badge.
  */
  useEffect(() => {
    if (!mounted) return;

    const timer = setTimeout(() => {
      const store = createDraftStore(draftStorage());

      setDraftSaved(
        store.save({
          [DRAFT_FIELD_QUESTION]: question,
          [DRAFT_FIELD_OPTIONS]: options,
          [DRAFT_FIELD_DEADLINE]: deadline,
          [DRAFT_FIELD_ADMISSION]: openToAll,
          [DRAFT_FIELD_TEMPLATE]: templateId ?? "",
        }),
      );
    }, DRAFT_SAVE_DELAY_MS);

    // The handle is kept in a ref so `discardDraft` can cancel a pending write
    // before removing the slot — otherwise the two race and the draft comes back.
    saveTimer.current = timer;

    return () => {
      clearTimeout(timer);
      saveTimer.current = null;
    };
  }, [mounted, question, options, deadline, openToAll, templateId]);

  const selectedTemplate: PollTemplate | null =
    templateId === null ? null : findTemplate(templateId);

  const deadlineMs = deadline === "" ? INVALID_DATE : new Date(deadline).getTime();
  const endsAt = Number.isNaN(deadlineMs) ? null : BigInt(Math.floor(deadlineMs / 1000));

  // Only non-empty option fields become options. An empty field is a row the
  // reader added and has not filled in yet, not an option named "".
  const filled = options.map((option) => option.trim()).filter((option) => option.length > 0);

  // The config that will actually be submitted: the template's (or the contract
  // defaults), with the reader's admission applied and the multi-select cap
  // lowered to the options that exist. Derived in ONE place rather than inside
  // `submit`, because the template panel prints it — a reader who changes
  // admission or an option has to see the config change with it, and two
  // computations of it would eventually disagree.
  const pollConfig: PollConfig = buildPollConfig(
    selectedTemplate ?? DEFAULT_TEMPLATE,
    { openToAll },
    filled.length,
  );

  // What the template panel describes: the config the poll will actually be
  // created with, not a second reading of the template's defaults.
  const mechanismSummary = describeMechanisms(pollConfig, locale);

  // Why the contract would refuse this config, or `null`. Computed once and used
  // twice — the admission field below states it where the reader caused it, and
  // `reason()` repeats it on the disabled submit button.
  const configProblem = describeConfigProblem(pollConfig, locale);

  function reason(): string | undefined {
    if (!mounted) {
      return undefined;
    }

    if (!factoryKnown) {
      const chainId = target?.chainId ?? walletChainId;

      return t("create.reason.noFactory", { chainId, chainName: chainName(chainId, locale) });
    }

    if (!isConnected) {
      return t("create.reason.connectFirst");
    }

    if (txBusy) {
      return ballot.busy;
    }

    if (question.trim().length === 0) {
      return t("create.reason.emptyQuestion");
    }

    if (filled.length < MIN_OPTIONS) {
      return t("create.reason.tooFewOptions", { min: MIN_OPTIONS });
    }

    if (endsAt === null) {
      return t("create.reason.noDeadline");
    }

    if (endsAt <= BigInt(Math.floor(Date.now() / 1000))) {
      // Checked here as well as by the contract because the transaction would
      // otherwise cost a wallet prompt and a revert for a field the reader can
      // plainly see is in the past.
      return t("create.reason.deadlinePast");
    }

    // The mechanisms, checked by the same `validateConfig` the chain runs.
    // Choosing a template can produce a config the contract refuses — `加权`
    // with the admission radio set to 所有人可投 is the one a reader can build
    // from the visible controls — and finding that out from a revert costs a
    // wallet prompt for a rule that was knowable before it.
    if (configProblem !== null) {
      return configProblem;
    }

    return undefined;
  }

  const disabledReason = reason();

  function submit() {
    // `reason()` is re-derived rather than read off `disabledReason` because the
    // button is disabled whenever it is non-undefined; the duplicate check here
    // is what stops the keyboard-Enter path from submitting anyway.
    if (endsAt === null || target === null || disabledReason !== undefined) {
      return;
    }

    // The ABI types the four count fields as `bigint`, and the mirror in
    // `mechanisms.ts` deliberately uses plain `number` — a UI control deals in
    // counts a human typed, and carrying `bigint` through the form state would
    // make every comparison against the input's value awkward. The conversion
    // therefore belongs here, at the boundary where the numbers become calldata,
    // rather than in the shared mirror where it would infect every consumer.
    const config = {
      ...pollConfig,
      maxSelections: BigInt(pollConfig.maxSelections),
      revealWindowSeconds: BigInt(pollConfig.revealWindowSeconds),
      quorumBps: BigInt(pollConfig.quorumBps),
      timelockSeconds: BigInt(pollConfig.timelockSeconds),
    };

    writeContract({
      address: target.factoryAddress,
      abi: factoryAbi,
      functionName: "createPoll",
      // The fifth argument is the execution target list. Empty means the poll
      // may only call itself, which is the safe default: a target list is what
      // lets a passed vote reach anything else, and this form does not yet
      // offer a way to choose those, so it must not invent one.
      args: [question.trim(), filled, endsAt, config, []],
    });
  }

  const cidCount = filled.filter((option) => isPlausibleCid(option)).length;

  /**
   * Adopts a template's mechanism config, or the contract defaults for `null`.
   *
   * The admission radio is set from the template's own `defaultAdmission`
   * instead of being left where it was: `加权` requires the whitelist, and
   * leaving a `所有人可投` radio selected under it would present a combination
   * `validateConfig` refuses as if it were the template's config. The question,
   * options and deadline are untouched — a template chooses a mechanism, not the
   * text of the poll.
   */
  function applyTemplate(id: string | null) {
    const template = id === null ? null : findTemplate(id);

    if (template === null) {
      setTemplateId(null);
      return;
    }

    setTemplateId(template.id);
    setOpenToAll(template.defaultAdmission.openToAll);
  }

  /**
   * Throws the stored draft away and empties the form.
   *
   * The pending autosave is cancelled first. Without that, a timer scheduled
   * microseconds earlier fires after the removal and writes the draft straight
   * back — the reader would see "已清除草稿" over a draft that is still there.
   */
  function discardDraft() {
    if (saveTimer.current !== null) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }

    const cleared = createDraftStore(draftStorage()).clear();

    setQuestion("");
    setOptions(["", ""]);
    setDeadline("");
    setOpenToAll(true);
    setTemplateId(null);
    setDraftRestored(false);
    // `false` is the honest report that storage refused to remove the entry; the
    // form is empty either way, and the reader is told the stored copy may
    // return on reload rather than being left to discover it.
    setDraftSaved(cleared ? null : false);
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      {/*
        Collapsed by default, and the form's own state is NOT discarded when it
        closes: a reader who fills in three options, collapses the panel to check
        the poll list, and reopens it would otherwise lose everything they typed.
        So this is a `hidden` wrapper rather than conditional rendering — the
        inputs stay mounted and keep their values.

        The panel opens itself when there is something to show: an error from a
        failed attempt must not be invisible behind a collapsed header.
      */}
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-3 rounded-xl px-5 py-4 text-left transition hover:bg-slate-50"
      >
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-slate-900">{t("create.heading")}</span>
          <span className="mt-0.5 block text-xs text-slate-500">
            {expanded ? t("create.subtitleExpanded") : t("create.subtitleCollapsed")}
          </span>
        </span>
        <span
          aria-hidden="true"
          className={`shrink-0 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition ${
            expanded ? "" : "bg-slate-50"
          }`}
        >
          {expanded ? t("common.collapse") : t("common.expand")}
        </span>
      </button>

      {/*
        `data-create-panel` is what the browser drill toggles: it must be able to
        reach this form in every run, and a click target keyed on Chinese text
        would break the moment the copy is edited.
      */}
      <div
        hidden={!expanded}
        data-create-panel={expanded ? "open" : "closed"}
        className="border-t border-slate-100 px-5 pb-5 pt-4"
      >
        <p className="text-xs leading-relaxed text-slate-500">{t("create.intro")}</p>

        {/*
          The draft notice. It is only shown when a draft was actually READ back
          on mount, and it says where the values came from — a form that quietly
          refills itself is indistinguishable from one that never cleared, and a
          reader about to sign a transaction should know what they are looking at.
        */}
        {draftRestored && (
          <p
            data-draft-restored="true"
            className="mt-2 rounded-lg bg-slate-50 p-2.5 text-[11px] leading-relaxed text-slate-500"
          >
            {t("create.draftRestored")}
          </p>
        )}

        {/*
          The template choice, above the fields it configures. The mechanism it
          writes is fixed at `initialize`, so it is a decision about the poll
          rather than a filter over the form — which is why it sits where the
          reader sees it before typing, not in a settings fold at the bottom.
        */}
        <div className="mt-4">
          <span className="text-xs text-slate-500">{t("create.templateLabel")}</span>
          <div className="mt-1">
            <TemplatePicker
              selectedId={templateId}
              selected={selectedTemplate}
              mechanismSummary={mechanismSummary}
              dirty={templateId !== null}
              onSelect={applyTemplate}
            />
          </div>
        </div>

        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="text-xs text-slate-500">{t("create.questionLabel")}</span>
            <input
              type="text"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder={t("create.questionPlaceholder")}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
            />
          </label>

          <div>
            <span className="text-xs text-slate-500">
              {t("create.optionsLabel", { min: MIN_OPTIONS })}
            </span>

            <div className="mt-1 space-y-2">
              {options.map((option, index) => (
                <div key={index} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={option}
                    onChange={(event) =>
                      setOptions((current) =>
                        current.map((value, i) => (i === index ? event.target.value : value)),
                      )
                    }
                    placeholder={
                      index === 0
                        ? t("create.optionPlaceholderFirst")
                        : t("create.optionPlaceholderNumbered", { number: index + 1 })
                    }
                    aria-label={t("create.optionPlaceholderNumbered", { number: index + 1 })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs outline-none focus:border-slate-500"
                  />
                  {options.length > MIN_OPTIONS && (
                    <button
                      type="button"
                      onClick={() => setOptions((current) => current.filter((_, i) => i !== index))}
                      className="shrink-0 rounded-lg border border-slate-200 px-2.5 py-2 text-xs text-slate-500 transition hover:bg-slate-50"
                    >
                      {t("create.removeOption")}
                    </button>
                  )}
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={() => setOptions((current) => [...current, ""])}
              className="mt-2 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
            >
              {t("create.addOption")}
            </button>
          </div>

          <label className="block">
            <span className="text-xs text-slate-500">{t("create.deadlineLabel")}</span>
            <input
              type="datetime-local"
              value={deadline}
              onChange={(event) => setDeadline(event.target.value)}
              className="mt-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
            />
            <span className="mt-1 block text-[11px] text-slate-400">
              {t("create.deadlineHint")}
            </span>
          </label>

          {/*
          The admission choice, and the one field here that cannot be changed
          afterwards: `openToAll` is fixed at `initialize` and there is no setter.
          Saying so before the transaction is the same discipline the CID hint
          below applies — the reader is about to make a permanent choice, and the
          contract will not let them revise it.
        */}
          <fieldset>
            <legend className="text-xs text-slate-500">{t("create.admissionLegend")}</legend>

            <div className="mt-1 space-y-1.5">
              <label className="flex items-start gap-2 text-xs text-slate-700">
                <input
                  type="radio"
                  name="admission"
                  checked={openToAll}
                  onChange={() => setOpenToAll(true)}
                  className="mt-0.5"
                />
                <span>
                  <strong>{t("create.admissionOpen")}</strong>
                  <span className="ml-1 text-slate-500">{t("create.admissionOpenHint")}</span>
                </span>
              </label>

              <label className="flex items-start gap-2 text-xs text-slate-700">
                <input
                  type="radio"
                  name="admission"
                  checked={!openToAll}
                  onChange={() => setOpenToAll(false)}
                  className="mt-0.5"
                />
                <span>
                  <strong>{t("create.admissionWhitelist")}</strong>
                  <span className="ml-1 text-slate-500">{t("create.admissionWhitelistHint")}</span>
                </span>
              </label>
            </div>

            <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
              {t("create.admissionFixed")}
              <strong>{t("create.admissionFixedEmphasis")}</strong>
              {t("create.admissionFixedTail")}
            </p>

            {/*
              The template/admission conflict, named where the reader caused it.
              The submit-button reason below says the same thing, but it sits at
              the bottom of the panel and is a `title` on a disabled button —
              which is exactly the "explains itself somewhere the reader is not
              looking" shape ADR-0027 exists to prevent. `加权` + `所有人可投` is
              reachable from these two controls alone, so it is said here.
            */}
            {configProblem !== null && (
              <p
                data-config-problem="true"
                className="mt-1.5 text-[11px] leading-relaxed text-amber-600"
              >
                {configProblem}
              </p>
            )}
          </fieldset>
        </div>

        {/*
        The honesty line. It states what will be written, per option, before the
        transaction — because after it, nothing can correct the value.
      */}
        {filled.length > 0 && (
          <p className="mt-3 rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">
            {t("create.cidSummary1", { total: filled.length, cids: cidCount })}
            <strong>{t("create.cidEmphasis")}</strong>
            {t("create.cidSummary2", { raw: filled.length - cidCount })}
            <strong>{t("create.cidRawEmphasis")}</strong>
            {t("create.cidSummary3")}
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={submit}
            disabled={disabledReason !== undefined}
            title={disabledReason}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {txBusy ? ballot.busy : t("create.submit")}
          </button>
          {mounted && disabledReason !== undefined && (
            <span className="text-xs text-slate-400">{disabledReason}</span>
          )}
        </div>

        {/*
          The draft status, and the manual clear.

          Deliberately terse: the positive sentence is the only claim that the
          values are stored, and it is only rendered after `saveDraft` returned
          true. A failed write renders a different sentence, because a form that
          says a draft is kept when the browser refused the write is lying about
          the one thing this feature promises. The clear button exists because a
          reader who abandons a poll has no other way to remove what was typed,
          and it takes effect without a confirmation for the same reason the
          fields are not confirmed: the values are in front of them and retyping
          is cheap.
        */}
        {mounted && (draftSaved !== null || question.length > 0 || filled.length > 0) && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
            {draftSaved === true && (
              <span data-draft-status="saved" className="text-slate-400">
                {t("create.draftSaved")}
              </span>
            )}
            {draftSaved === false && (
              <span data-draft-status="unsaved" className="text-amber-600">
                {t("create.draftUnsaved1")}
                <strong>{t("create.draftUnsavedEmphasis")}</strong>
                {t("create.draftUnsaved2")}
              </span>
            )}
            <button
              type="button"
              onClick={discardDraft}
              data-draft-clear="true"
              className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] text-slate-500 transition hover:bg-slate-50"
            >
              {t("create.clearDraft")}
            </button>
          </div>
        )}

        {hash !== undefined && (
          <p className="mt-3 break-all font-mono text-[11px] text-slate-500">
            {t("ballot.transaction")} {hash}
            {receipt.isPending && t("ballot.awaitingConfirmation")}
            {receipt.isSuccess && t("create.created")}
          </p>
        )}

        {writeFailure !== null && (
          <p
            className="mt-2 text-xs text-rose-600"
            data-write-error={writeFailure.classified ? "classified" : "unclassified"}
          >
            {writeFailure.text}
          </p>
        )}

        {address === undefined && mounted && (
          <p className="mt-2 text-[11px] text-slate-400">{t("create.connectForCreator")}</p>
        )}
      </div>
    </section>
  );
}
