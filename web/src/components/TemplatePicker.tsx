"use client";

import { POLL_TEMPLATES, type PollTemplate } from "@/lib/templates";

/**
 * The template row on the create form.
 *
 * ---------------------------------------------------------------------------
 * Why this is a row of buttons and not a <select>
 * ---------------------------------------------------------------------------
 *
 * A template is not a filter or a preference: picking one changes which
 * mechanism the poll is created with, permanently, and the reader cannot tell
 * that from a collapsed dropdown whose visible part is the word "多选". So each
 * option is a button showing its own name, and the selected one explains itself
 * underneath — including the parts the reader did NOT ask for, because a
 * weighted poll has to be whitelisted and that is worth knowing before the
 * choice is made rather than from a reverted transaction.
 *
 * ---------------------------------------------------------------------------
 * Why switching is destructive and therefore confirmed
 * ---------------------------------------------------------------------------
 *
 * The template decides the mechanism config the form submits, so switching after
 * typing replaces that config. The typed question and options are NOT touched —
 * what is replaced is the part a reader could not recover by retyping a field
 * they can see. The confirmation only appears when a template is already
 * selected, so the common case (pick one, start typing) never meets a dialog.
 *
 * ---------------------------------------------------------------------------
 * Why the summary is a prop and not computed here
 * ---------------------------------------------------------------------------
 *
 * The summary in `mechanismSummary` is the one the FORM will submit, which
 * depends on the reader's admission choice and their option count — not on the
 * template alone. Recomputing it here from the template would print a config the
 * poll is not going to be created with, which is exactly the "second copy of a
 * derived value" this repository forbids. The parent owns the config, so the
 * parent owns the sentence describing it.
 */

export interface TemplatePickerProps {
  /** The selected template's id, or `null` when the reader is on the plain defaults. */
  selectedId: string | null;
  /** The template the form is using, or `null` for the defaults. */
  selected: PollTemplate | null;
  /** The mechanisms of the config that will actually be submitted. */
  mechanismSummary: string;
  /** True when a template is applied, so switching would replace its config. */
  dirty: boolean;
  /** Applies a template, or clears back to the contract defaults with `null`. */
  onSelect: (id: string | null) => void;
}

export function TemplatePicker({
  selectedId,
  selected,
  mechanismSummary,
  dirty,
  onSelect,
}: TemplatePickerProps) {
  function choose(id: string | null, label: string) {
    if (id === selectedId) return;

    if (
      dirty &&
      !window.confirm(`切换到「${label}」会替换当前的机制配置，已填写的字段保留。继续吗？`)
    ) {
      return;
    }

    onSelect(id);
  }

  return (
    <div data-template-picker={selectedId ?? "none"}>
      <div className="flex flex-wrap gap-2">
        {/*
          The defaults button is not one of `POLL_TEMPLATES`: "keep the contract
          defaults" is the absence of a template, and spelling it as a fourth
          template would put a config in the list that means "no config".
        */}
        {POLL_TEMPLATES.map((template) => {
          const active = template.id === selectedId;

          return (
            <button
              key={template.id}
              type="button"
              data-template={template.id}
              aria-pressed={active}
              onClick={() => choose(template.id, template.name)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                active
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-300 text-slate-700 hover:bg-slate-50"
              }`}
            >
              {template.name}
            </button>
          );
        })}

        <button
          type="button"
          data-template="defaults"
          aria-pressed={selectedId === null}
          onClick={() => choose(null, "默认配置")}
          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
            selectedId === null
              ? "border-slate-900 bg-slate-900 text-white"
              : "border-slate-300 text-slate-700 hover:bg-slate-50"
          }`}
        >
          默认
        </button>
      </div>

      {selected !== null && (
        <div className="mt-2 space-y-1">
          <p className="text-[11px] leading-relaxed text-slate-500">{selected.description}</p>
          <p
            data-template-summary={selected.id}
            className="font-mono text-[11px] leading-relaxed text-slate-400"
          >
            {mechanismSummary}
          </p>
        </div>
      )}
    </div>
  );
}
