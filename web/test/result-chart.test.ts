// SPDX-License-Identifier: MIT
/**
 * The chart's geometry and its spoken summary.
 *
 * `ResultChart` renders a picture of the SAME tally the option cards print, and
 * the only way that stays true is if every number it draws is a function of that
 * tally. So the tests below are all about the derivation: a percentage of the
 * total, a length that stays inside the track, an empty canvas that is described
 * as empty rather than drawn as a row of zero-width bars, and an `aria-label`
 * that spells the result out instead of announcing that a picture exists.
 *
 * The one property that is asserted from several angles is "the percentage is the
 * total's, not the largest bar's". A tally whose largest count equals its total —
 * the ordinary single-select poll — cannot tell the two denominators apart, which
 * is exactly why the shared fixture below has a maximal count that does not equal
 * the total.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  chartAriaLabel,
  chartGeometry,
  chartHeight,
  chartViewBox,
  noVotesMessage,
  type ResultOption,
} from "../src/components/ResultChart";
import { tallySourceLabel } from "../src/lib/ballot-labels";
import { sharePercent } from "../src/lib/presentation";

/** What one bar is expected to be, given the whole tally. */
interface Shape {
  id: number;
  voteCount: number;
  percent: number;
  width: number;
}

/**
 * A tally seen only through the two things this suite must be able to state
 * independently: its layout, and the result it represents.
 *
 * `total` is deliberately independent of the counts. Every assertion below that
 * mentions a percentage has to keep working when the counts are re-scaled, which
 * is how "derived from the total" is pinned rather than "happens to match".
 */
interface Tally {
  options: ResultOption[];
  total: number;
}

/** The bars, or a failed assertion naming the empty case for what it is. */
function bars(tally: Tally) {
  const chart = chartGeometry(tally.options, tally.total);

  assert.equal(
    chart.kind,
    "bars",
    "a tally with votes must produce bars; the no-votes branch is not a place to hide",
  );

  return chart.kind === "bars" ? chart.bars : [];
}

/** Every bar, reduced to the four values a test can state on its own. */
function shapes(options: ResultOption[], total: number): Shape[] {
  return bars({ options, total }).map((bar) => ({
    id: bar.id,
    voteCount: bar.voteCount,
    percent: bar.percent,
    width: bar.width,
  }));
}

describe("chartGeometry", () => {
  it("gives equal votes equal bars, each with the total's share", () => {
    // Four options, eight votes, two each: 25% apiece and identical geometry. The
    // old failure this guards against is a bar chart in which equal counts are
    // drawn at different lengths because the length came from the index.
    const options: ResultOption[] = [
      { id: 1, voteCount: 2 },
      { id: 2, voteCount: 2 },
      { id: 3, voteCount: 2 },
      { id: 4, voteCount: 2 },
    ];

    assert.deepEqual(shapes(options, 8), [
      { id: 1, voteCount: 2, percent: 25, width: 18 },
      { id: 2, voteCount: 2, percent: 25, width: 18 },
      { id: 3, voteCount: 2, percent: 25, width: 18 },
      { id: 4, voteCount: 2, percent: 25, width: 18 },
    ]);
  });

  it("gives the only option every vote, at the full track width and 100%", () => {
    const [bar] = bars({ options: [{ id: 7, voteCount: 5 }], total: 5 });

    assert.equal(bar?.voteCount, 5);
    assert.equal(bar?.percent, 100);
    // The track is 70 viewBox units wide; the leader always fills it, because
    // the geometry is normalised to the largest bar rather than to the total.
    assert.equal(bar?.width, 70);
  });

  it("draws nothing at all when nobody has voted, and says so in words", () => {
    // The ADR-0011 case, from the other side: zero votes is a real answer, so it
    // gets a sentence. Drawing it instead would mean a figure full of zero-width
    // bars under a confident 0%, which reads as "this option is losing" rather
    // than "nothing has been counted".
    const chart = chartGeometry([{ id: 1, voteCount: 0 }], 0);

    assert.equal(chart.kind, "no-votes");
    assert.equal(chart.kind === "no-votes" ? chart.message : "", noVotesMessage());
    assert.match(noVotesMessage(), /还没有票/);

    // And no geometry is reachable from that branch, so a caller cannot draw one.
    assert.equal("bars" in chart, false);
  });

  it("draws every option of a poll with the form's maximum of them", () => {
    // 20 options is at the top of what `CreatePollForm` allows. The counts are the
    // ones a real ballot produces — the total is their sum, because that is what
    // `results()` returns — and they are spread out enough that the leader is a
    // small part of the poll, which is the state the whole picture has to survive.
    const options: ResultOption[] = Array.from({ length: 20 }, (_unused, index) => ({
      id: index + 1,
      voteCount: index + 1,
    }));
    const total = options.reduce((running, option) => running + option.voteCount, 0);
    assert.equal(total, 210);

    const chart = bars({ options, total });

    assert.equal(chart.length, 20, "every option gets a bar, including the last");

    // Distinct, descending rows: no two bars may share a y, or the chart would
    // silently drop one of them behind another.
    const ys = chart.map((bar) => bar.y);
    assert.equal(new Set(ys).size, 20);
    assert.deepEqual(
      ys,
      [...ys].sort((a, b) => a - b),
      "bars run top to bottom in the tally's own order",
    );

    // Widths follow the counts and only the counts. The expected list is the
    // arithmetic done once, by hand, so a change in the scale factor cannot pass
    // unnoticed: each entry is `round(count / 210 * 70)`.
    const expectedWidths = [0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6, 7];
    assert.deepEqual(
      chart.map((bar) => bar.width),
      expectedWidths,
      "a bar's length is its share of the largest of the counts and the total",
    );
    assert.deepEqual(
      expectedWidths,
      [...expectedWidths].sort((a, b) => a - b),
      "the fixture must be ordered smallest count first, which the next assertions rely on",
    );

    for (const bar of chart) {
      assert.ok(bar.width >= 0 && bar.width <= 70, "a bar must stay inside its track");
      assert.ok(bar.percent >= 0 && bar.percent <= 100);
    }

    // The lowest count in a twenty-option poll rounds to no visible length. That
    // is the honest rendering — a sliver would claim a size the count does not
    // have — and it is why the count and the percentage are printed beside every
    // bar rather than left to the geometry.
    assert.equal(chart[0]?.voteCount, 1);
    assert.equal(chart[0]?.width, 0);
    assert.equal(chart.at(-1)?.width, 7, "20 of 210 selections, as a share of the track");

    for (const bar of chart) {
      assert.ok(bar.width >= 0 && bar.width <= 70, "a bar must stay inside its track");
      assert.ok(bar.percent >= 0 && bar.percent <= 100);
    }

    // The share is the total's, so the twenty options' percentages are the whole
    // poll and not twenty readings of the largest bar.
    const shared = chart.reduce((running, bar) => running + bar.percent, 0);
    assert.ok(
      Math.abs(shared - 100) < 0.5,
      `the shares must describe the whole poll, got ${shared}`,
    );
  });

  it("keeps every bar inside the track when a count exceeds the declared total", () => {
    // A stale or torn `total` must not produce a bar wider than the canvas: the
    // renderer would clip it against the figure edge while the printed number
    // still claimed to be the whole story.
    const chart = bars({
      options: [
        { id: 1, voteCount: 9 },
        { id: 2, voteCount: 3 },
      ],
      total: 4,
    });

    assert.ok((chart[0]?.width ?? 70) <= 70);
    assert.ok((chart[1]?.width ?? 70) <= 70);
    assert.equal(chart[0]?.width, 70, "the largest count still defines the scale");
  });

  it("names an option it has no label for, rather than rendering an empty row", () => {
    const chart = bars({
      options: [
        { id: 3, voteCount: 1 },
        { id: 4, voteCount: 1, label: "元数据里的名字" },
      ],
      total: 2,
    });

    assert.equal(chart[0]?.label, "选项 #3");
    assert.equal(chart[1]?.label, "元数据里的名字", "a supplied label is used as-is");
  });

  it("lay out only at positions the canvas has room for", () => {
    const options: ResultOption[] = [
      { id: 1, voteCount: 3 },
      { id: 2, voteCount: 2 },
      { id: 3, voteCount: 1 },
    ];
    const chart = bars({ options, total: 6 });
    const height = chartHeight(chart.length);

    assert.ok(height > 0, "bars need a canvas with a height");
    assert.equal(chart[0]?.y, 0, "the first bar starts at the top");
    assert.ok(
      (chart[2]?.y ?? height) + (chart[2]?.height ?? 0) <= height,
      "the last bar must not be placed outside the canvas",
    );
    assert.equal(chartHeight(0), 0, "no bars is a canvas of no height, not a negative one");
    assert.match(chartViewBox(chart.length), /^0 0 [\d.]+ [\d.]+$/);
  });
});

describe("chartAriaLabel", () => {
  it("spells out the result rather than announcing that a picture exists", () => {
    const label = chartAriaLabel({
      source: "chain",
      total: 8,
      options: [
        { id: 1, voteCount: 4 },
        { id: 2, voteCount: 3 },
        { id: 3, voteCount: 1 },
      ],
    });

    assert.match(label, /^结果图表：/);
    assert.match(label, /选项 #1 4 票（50%）/, "each option's own count and share");
    assert.match(label, /选项 #2 3 票（37\.5%）/);
    assert.match(label, /选项 #3 1 票（12\.5%）/);
    assert.match(label, /合计 8 票/);
    assert.match(label, /数据来源：链上直读/);
    assert.notEqual(label, "结果图表", "a label that only names the widget is the defect");
    assert.ok(label.length > 30, "the real result takes more than a phrase to state");
  });

  it("uses the app's own words for the source, from the shared label owner", () => {
    // Same function `tallyLabels` renders in the 数据来源 row, so the chart and
    // the text cannot describe their provenance differently.
    assert.equal(tallySourceLabel("chain"), "链上直读");
    assert.equal(tallySourceLabel("index"), "MySQL 索引");

    const fromIndex = chartAriaLabel({
      source: "index",
      total: 2,
      options: [{ id: 1, voteCount: 2 }],
    });
    assert.match(fromIndex, /数据来源：MySQL 索引/);
    assert.doesNotMatch(fromIndex, /链上直读/);
  });

  it("states a zero tally in words, and still names its source", () => {
    const label = chartAriaLabel({
      source: "chain",
      total: 0,
      options: [
        { id: 1, voteCount: 0 },
        { id: 2, voteCount: 0 },
      ],
    });

    assert.match(label, /还没有票/);
    assert.match(label, /数据来源：链上直读/);
    assert.doesNotMatch(label, /0 票（0%）/, "zero options are not enumerated one by one");
  });

  it("states a poll with no options as having none, not as having no votes", () => {
    // A poll mid-creation has an empty option list. Telling a reader "还没有票"
    // would be technically true and misleading: the poll has nothing to vote on.
    const label = chartAriaLabel({ source: "chain", total: 0, options: [] });

    assert.match(label, /还没有选项/);
    assert.match(label, /数据来源：链上直读/);
    assert.doesNotMatch(label, /还没有票/);
    assert.doesNotMatch(label, /：。/, "an empty list must not leave a broken sentence behind");
  });

  it("computes each share from the total, not from the largest count", () => {
    // The counts' maximum is 4 and the total is 8. A label built from the maximum
    // would say 100% / 75% / 25%; the truth is 50% / 37.5% / 12.5%.
    const options: ResultOption[] = [
      { id: 1, voteCount: 4 },
      { id: 2, voteCount: 3 },
      { id: 3, voteCount: 1 },
    ];
    const label = chartAriaLabel({ source: "chain", total: 8, options });

    assert.match(label, /选项 #1 4 票（50%）/);
    assert.doesNotMatch(label, /100%/, "the largest bar is not the whole poll");
    assert.doesNotMatch(label, /75%/);
  });
});

describe("the chart's numbers agree with the tally it was handed", () => {
  it("adds up to the tally's own total", () => {
    const options: ResultOption[] = [
      { id: 1, voteCount: 4 },
      { id: 2, voteCount: 3 },
      { id: 3, voteCount: 1 },
    ];
    const total = 8;

    const sum = options.reduce((running, option) => running + option.voteCount, 0);
    assert.equal(sum, total, "the fixture is a tally the contract could actually return");

    const chart = bars({ options, total });
    assert.equal(
      chart.reduce((running, bar) => running + bar.voteCount, 0),
      total,
      "the chart must not invent or lose a vote on the way to the picture",
    );
  });

  it("keeps the count printed on a bar equal to the count in the tally", () => {
    const options: ResultOption[] = [
      { id: 11, voteCount: 4 },
      { id: 12, voteCount: 3 },
      { id: 13, voteCount: 1 },
    ];

    assert.deepEqual(
      bars({ options, total: 8 }).map((bar) => [bar.id, bar.voteCount]),
      options.map((option) => [option.id, option.voteCount]),
    );
  });

  it("reports the same count and percentage the option cards report", () => {
    // The load-bearing property of the whole component: one tally, two
    // renderings, no second derivation. `OptionRow` prints `voteCount` and
    // `sharePercent(voteCount, total)`; the chart's bar must carry exactly those
    // two numbers for the same option, or the page is telling two stories about
    // one read.
    const tally = {
      source: "chain" as const,
      total: 17,
      options: [
        { id: 1, voteCount: 9 },
        { id: 2, voteCount: 5 },
        { id: 3, voteCount: 3 },
      ],
    };

    const chart = bars({ options: tally.options, total: tally.total });

    assert.deepEqual(
      chart.map((bar) => [bar.id, bar.voteCount, bar.percent]),
      tally.options.map((option) => [
        option.id,
        option.voteCount,
        sharePercent(option.voteCount, tally.total),
      ]),
    );

    // And the spoken label carries the same numbers again, so a reader using it
    // is not being given a third set.
    const label = chartAriaLabel(tally);
    for (const bar of chart) {
      assert.ok(
        label.includes(`${bar.voteCount} 票（${bar.percent}%）`),
        `the label must state ${bar.label}'s own numbers, got: ${label}`,
      );
    }
  });
});
