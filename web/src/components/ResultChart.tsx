// SPDX-License-Identifier: MIT
/**
 * The tally as a picture, drawn by hand rather than by a charting library.
 *
 * ---------------------------------------------------------------------------
 * Why inline SVG and no dependency
 * ---------------------------------------------------------------------------
 *
 * A poll here has a handful of options (`CreatePollForm` caps them well below
 * twenty), which is far inside the range where a bar chart is a loop over an
 * array. d3 and recharts both pay for that loop with tens of kilobytes, a
 * browser-only rendering model, and a hydration boundary — the last of which
 * matters most, because this chart sits inside `PollBallot`, a client component,
 * and anything it pulls in is downloaded by every reader of every poll. The
 * geometry below is arithmetic; there is nothing for a library to do that is not
 * done here.
 *
 * ---------------------------------------------------------------------------
 * Why the numbers are computed and never written twice
 * ---------------------------------------------------------------------------
 *
 * The chart and the textual tally read ONE object — the same `source` / `total` /
 * `options` triple the rest of the app already passes around (`TallyResponse`) —
 * and every bar is derived from it by the pure functions in this file. A bar
 * width, a percentage and the spoken summary are all functions of the same
 * `voteCount` and `total`, so the picture cannot claim something the numbers do
 * not: there is no second list of percentages to fall out of date. That is the
 * repo's "派生值一律从单一来源生成" rule applied to a diagram.
 *
 * ---------------------------------------------------------------------------
 * Why "we could not read the tally" is not a state of this component
 * ---------------------------------------------------------------------------
 *
 * The component is handed a tally that has ALREADY been decided, so it has no
 * branch in which a failed read could render as an empty chart. "The read failed"
 * is answered on the page by the options block's own failure notice (ADR-0011:
 * never present "could not read" as "there is nothing"), and the chart is not
 * rendered at all in that case — `PollBallot` mounts it only where `results()` is
 * in hand. What the component does own is the honest zero: a tally of zero votes
 * is a real answer, and it renders a sentence saying so instead of a row of
 * zero-length bars underneath a confident "0%".
 */
import { tallySourceLabel } from "@/lib/ballot-labels";
import {
  ballotPhrasesFor,
  DEFAULT_LOCALE,
  interpolate,
  messagesFor,
  type Locale,
} from "@/lib/i18n";
import { sharePercent } from "@/lib/presentation";
import type { TallyResponse } from "@/lib/types";

/**
 * One option, as the chart needs it.
 *
 * `label` is optional and often absent: the chart lives inside the ballot's
 * options section, where the same option is named by a card whose name came from
 * IPFS, and passing that name down would be a SECOND derivation of it. The
 * identifiers are the fallback, and they are not ambiguous — the option cards
 * print `#<id>` in the same place.
 */
export interface ResultOption {
  id: number;
  voteCount: number;
  label?: string;
}

/**
 * The canvas, in viewBox units.
 *
 * The SVG uses a `viewBox` and is sized by CSS, so these numbers are proportions
 * rather than pixels and the chart stays sharp at any width. The reserved left
 * column is why the option names are SVG `<text>` rather than a separate HTML
 * column: it makes each label part of the same coordinate system as its bar, so
 * a label can never drift away from the bar it names.
 *
 * Every constant here is in the same unit as `TRACK`, which is what lets one
 * `fontSize` in viewBox units land at roughly one CSS size in the rendered
 * figure: the figure is normal card width, the viewBox is a hundred units wide,
 * so one unit is a few CSS pixels. `TEXT_SIZE` is chosen to land near the
 * `text-xs` the option cards use beside it.
 */
const LABEL_COLUMN = 26;
const MARGIN_AFTER_BARS = 4;
const TRACK = 70;
const BAR_HEIGHT = 7;
const BAR_GAP = 4;
const INNER_GAP = 2;
const TEXT_SIZE = 3.1;
const TOTAL_VIEW_WIDTH = LABEL_COLUMN + INNER_GAP + TRACK + MARGIN_AFTER_BARS;

/** One option's place on the canvas, everything already in viewBox units. */
export interface ResultBar {
  /** The option's own id, from the tally. Used as the render key. */
  id: number;
  /** What to print beside the bar. */
  label: string;
  voteCount: number;
  /** Share of `total`, one decimal, from the shared `sharePercent`. */
  percent: number;
  y: number;
  height: number;
  width: number;
}

/**
 * The chart, as data.
 *
 * A discriminated union rather than "bars plus a flag": the empty case genuinely
 * has no geometry, and a caller that had to check for an empty `bars` array
 * while also being able to read `width` would be one refactor away from drawing
 * a chart that says nothing.
 */
export type TallyChart =
  { kind: "bars"; bars: ResultBar[] } | { kind: "no-votes"; message: string };

/**
 * The sentence every empty tally gets. One spelling, in one place.
 *
 * A function of the language rather than a constant, because the chart is a
 * Server Component and a constant would freeze whichever language it was compiled
 * in. The NAME is kept so the sentence still has one owner: `chartGeometry` fills
 * it in and `chartAriaLabel` reads it back off the chart, so the caption, the
 * picture and the spoken label can never say three different things about the same
 * zero.
 */
export function noVotesMessage(locale: Locale = DEFAULT_LOCALE): string {
  return messagesFor(locale)["chart.noVotes"];
}

/**
 * Every option's bar, derived from the tally.
 *
 * Two numbers come out of the same `voteCount` and `total`, and they answer
 * different questions:
 *
 *   * `percent` is `voteCount / total` — how much of the poll this option is, in
 *     the same words the option cards print, from the same `sharePercent`;
 *   * `width` is the same share of the largest value in the tally, so the
 *     geometry is proportional and comparable rather than a set of numbers that
 *     each only make sense against a total the reader cannot see.
 *
 * The largest value in the tally is `max(largest count, total)` rather than the
 * total alone, and the difference only shows up when a caller's `total` is stale
 * or torn: `Poll.results()` defines the total as the sum of the counts, so on a
 * real tally the counts can never exceed it and the two definitions agree. When a
 * caller does hand over a smaller total — a multi-select tally read in two pieces
 * is the realistic way — normalising to the counts keeps every bar inside its
 * track instead of clipping the leaders against the figure edge, and keeps the
 * largest count at the full track width, which is a truthful "this is the biggest
 * bar" rather than a fraction of a scale nothing on the page explains.
 *
 * Neither number is written by hand anywhere, which is the repo's rule for a
 * derived value: the picture cannot claim something the printed numbers do not.
 *
 * A zero-vote option gets a zero-length bar rather than a minimum-width sliver: a
 * minimum would draw a mark for a count of nothing, and the count is printed next
 * to it anyway.
 */
export function chartGeometry(
  options: readonly ResultOption[],
  total: number,
  locale: Locale = DEFAULT_LOCALE,
): TallyChart {
  const phrases = ballotPhrasesFor(locale);

  if (total <= 0) {
    return { kind: "no-votes", message: noVotesMessage(locale) };
  }

  const counts = options.map((option) => option.voteCount);
  const maximal = counts.reduce((largest, count) => (count > largest ? count : largest), 0);
  // See the docblock: identical to `total` on any tally the contract can return,
  // and the thing that keeps bars inside the track when it is not. Also the reason
  // there is no `NaN` width for a caller holding options and a zero total — the
  // guard above already returned for that case.
  const scale = Math.max(maximal, total);

  const bars = options.map((option, index) => {
    const count = counts[index] ?? 0;

    return {
      id: option.id,
      // From the BALLOT catalogue, not the message catalogue: `选项 #{id}` is the
      // same sentence the option cards print, and the placeholder keeps its `#`
      // because `interpolate` only substitutes the braced name — which is what
      // makes the rendered label `选项 #3` rather than `选项 3`.
      label: option.label ?? interpolate(phrases.optionNumbered, { id: option.id }),
      voteCount: count,
      percent: sharePercent(count, total),
      y: index * (BAR_HEIGHT + BAR_GAP),
      height: BAR_HEIGHT,
      // Rounded at the end, not at the start: `round(round(x))` drifts, and a
      // test that pins these numbers should be pinning the geometry the renderer
      // actually receives.
      width: Math.round((Math.min(count, scale) / scale) * TRACK),
    };
  });

  return { kind: "bars", bars };
}

/**
 * The chart's vertical extent, so the SVG can reserve the space it draws in.
 *
 * Derived from the same bar count as the geometry, so a bar can never be placed
 * outside the canvas. Zero bars really do describe a canvas of no height, and no
 * caller renders one — `chartViewBox` is only reached from the `bars` branch.
 */
export function chartHeight(barCount: number): number {
  if (barCount <= 0) {
    return 0;
  }

  return barCount * BAR_HEIGHT + (barCount - 1) * BAR_GAP;
}

/** The canvas, in viewBox units, for however many bars there are. */
export function chartViewBox(barCount: number): string {
  return `0 0 ${TOTAL_VIEW_WIDTH} ${chartHeight(barCount)}`;
}

/**
 * The chart in words, for `aria-label`.
 *
 * This is the whole accessibility argument for the component: `role="img"` makes
 * a screen reader announce this attribute and NOTHING inside the SVG, so a label
 * of "结果图表" would replace a readable tally with the news that a picture
 * exists. Every option, its count and its share are therefore spelled out, and
 * the label is assembled only here — the component never appends to or edits it.
 *
 * A zero tally is named as such in words rather than enumerated: there is no
 * difference between one option at 0 票 and the next, and a reader hearing the
 * list read out at zero learns nothing the sentence does not already say. The
 * source is still named, because "0 票 from the chain" and "0 票 from the index"
 * are different claims. A poll with no options at all gets its own sentence, so
 * the label never opens with a list that turns out to be empty.
 *
 * Every number and every unit comes out of the catalogue's templates rather than
 * being concatenated here, because the two languages place them differently: a
 * reader is told "8 votes" in one and "8 票" in the other. What stays in this
 * function is the ORDER — which option, what count, which share — and the choice
 * between the four sentences, which is the part a translation must not reorder.
 */
export function chartAriaLabel(
  tally: {
    total: number;
    source: TallyResponse["source"];
    options: readonly ResultOption[];
  },
  locale: Locale = DEFAULT_LOCALE,
): string {
  const messages = messagesFor(locale);
  const source = tallySourceLabel(tally.source, locale);

  if (tally.options.length === 0) {
    // A poll created but never given an option list. "还没有票" would be true and
    // beside the point; the thing that is missing is the options themselves, and
    // the label says which of the two situations this is.
    return interpolate(messages["chart.ariaNoOptions"], { source });
  }

  if (tally.total <= 0) {
    return interpolate(messages["chart.ariaNoVotes"], {
      message: noVotesMessage(locale),
      source,
    });
  }

  const items = tally.options
    .map((option) =>
      interpolate(messages["chart.ariaItem"], {
        label:
          option.label ?? interpolate(ballotPhrasesFor(locale).optionNumbered, { id: option.id }),
        votes: option.voteCount,
        percent: sharePercent(option.voteCount, tally.total),
      }),
    )
    // The separator is Chinese punctuation and stays in the code, not in the
    // catalogue: it is a glyph between two whole clauses, so a translation has
    // nothing to reorder — and a key holding nothing but `；` is the kind of
    // "translation" `i18n.test.ts` refuses when two of them collide.
    .join("；");

  return interpolate(messages["chart.ariaBars"], {
    items,
    total: tally.total,
    source,
  });
}

/** One option as this component takes it: the tally's own fields, plus the source. */
export interface ResultChartProps {
  /**
   * The same tally object the textual results render from — `TallyResponse`, the
   * wire type the API, the chain reader and the ballot all already share. Passed
   * whole rather than spread into loose props, so there is no way to hand the
   * chart a total from one read and options from another.
   */
  tally: {
    source: TallyResponse["source"];
    total: number;
    options: readonly ResultOption[];
  };
  /**
   * The reader's language, as an ordinary prop.
   *
   * This file has no `"use client"` and must not gain one: it renders on the
   * server as part of the page's own answer, and `useTranslator()` is a client
   * hook. So the language travels down from whoever mounts it — `PollBallot`,
   * which is a Client Component and already resolved it — exactly as
   * `ConsistencyBadge` takes its translator.
   *
   * Defaulted rather than required, unlike `ConsistencyBadge`'s translator: this
   * component's unit tests call `chartGeometry` and `chartAriaLabel` directly and
   * every one of them asserts the Chinese, so a required prop would only push a
   * `DEFAULT_LOCALE` into thirty call sites without adding a check. The component
   * itself passes its own value straight through.
   */
  locale?: Locale;
}

/**
 * The tally as a bar chart, plus an accessible text rendering of the same result.
 *
 * A Server Component with no `"use client"`, like `ui.tsx` and for the same
 * reason: it holds no state and reads nothing, so it must not be the thing that
 * drags a client boundary into a page whose frame has to render when the data
 * layer is failing.
 *
 * The list under the SVG is not redundancy. A reader who cannot use fine geometry
 * still gets every number in a scannable list, and the `aria-label` becomes
 * checkable against something on the page instead of being a claim only a screen
 * reader ever hears.
 */
export function ResultChart({ tally, locale = DEFAULT_LOCALE }: ResultChartProps) {
  const messages = messagesFor(locale);
  const chart = chartGeometry(tally.options, tally.total, locale);
  const ariaLabel = chartAriaLabel(tally, locale);

  return (
    <figure data-result-chart className="rounded-xl border border-slate-200 bg-white p-4">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          {messages["chart.title"]}
        </span>
        <span className="text-xs text-slate-400">
          {interpolate(messages["chart.caption"], {
            // The SAME `tallySourceLabel` call the textual tally's 数据来源 row
            // makes. Writing the words again here is how the chart and the numbers
            // would start describing their own provenance differently.
            source: tallySourceLabel(tally.source, locale),
            total: tally.total,
          })}
        </span>
      </figcaption>

      {chart.kind === "no-votes" ? (
        // The honest zero: a sentence, not a chart of zero-width bars claiming
        // 0%. The caption above already reports `合计 0 票`; this says what that
        // means, so the figure is never a picture of nothing.
        <p data-chart-empty className="mt-3 text-sm text-slate-500">
          {chart.message}
        </p>
      ) : (
        <>
          <svg
            role="img"
            aria-label={ariaLabel}
            viewBox={chartViewBox(chart.bars.length)}
            className="mt-3 h-auto w-full"
          >
            {chart.bars.map((bar) => {
              const printed = interpolate(messages["chart.barValue"], {
                votes: bar.voteCount,
                percent: bar.percent,
              });

              return (
                <g key={bar.id}>
                  <text
                    x={LABEL_COLUMN}
                    y={bar.y + bar.height - 1.5}
                    textAnchor="end"
                    fontSize={TEXT_SIZE}
                    fill="#64748b"
                  >
                    {bar.label}
                  </text>
                  {/* The track, so a short bar is still read as "short of what". */}
                  <rect
                    x={LABEL_COLUMN + INNER_GAP}
                    y={bar.y}
                    width={TRACK}
                    height={bar.height}
                    rx={bar.height / 2}
                    fill="#f1f5f9"
                  />
                  <rect
                    data-chart-bar
                    x={LABEL_COLUMN + INNER_GAP}
                    y={bar.y}
                    width={bar.width}
                    height={bar.height}
                    rx={bar.height / 2}
                    fill="#334155"
                  />
                  <text
                    x={LABEL_COLUMN + INNER_GAP + TRACK + 1.5}
                    y={bar.y + bar.height - 1.5}
                    fontSize={TEXT_SIZE}
                    fill="#475569"
                  >
                    {printed}
                  </text>
                </g>
              );
            })}
          </svg>

          <ul className="mt-3 space-y-0.5 text-xs text-slate-600">
            {chart.bars.map((bar) => (
              <li key={bar.id} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate">{bar.label}</span>
                <span className="shrink-0 tabular-nums text-slate-500">
                  {interpolate(messages["chart.barValue"], {
                    votes: bar.voteCount,
                    percent: bar.percent,
                  })}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </figure>
  );
}
