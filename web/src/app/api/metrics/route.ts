// SPDX-License-Identifier: MIT
import { getHealth } from "@/lib/data";
import { createIndexErrorCounter, METRICS_CONTENT_TYPE, renderMetrics } from "@/lib/metrics";

export const dynamic = "force-dynamic";

/**
 * Prometheus exposition for this deployment.
 *
 * Deliberately a separate surface from `/api/health`, whose JSON shape is a
 * contract 14 call sites depend on: a scraper cannot read that payload, and
 * reshaping it for one consumer would break the others. This route reads the
 * same `getHealth()` — it is a second reader, never a second source of truth
 * about how far behind the index is.
 *
 * It is meant to be scraped over the internal network and is refused at the
 * reverse proxy. Nothing here reproduces a configuration value, so the payload
 * would be harmless anyway; the refusal is about not publishing an inventory of
 * the deployment to the internet.
 *
 * A failed reading answers 503 with an empty body rather than a payload, which
 * is what makes the scrape itself the liveness signal: Prometheus records
 * `up == 0`, and Grafana shows a gap instead of a stale line that looks like
 * healthy values.
 */
const observeIndexError = createIndexErrorCounter();

export async function GET() {
  try {
    // No locale argument on purpose. The counter below compares the rendered
    // `indexError` sentence, so pulling in the request's language would make a
    // language switch read as a brand new failure.
    const health = await getHealth();

    const body = renderMetrics({
      health,
      indexErrorsTotal: observeIndexError(health.indexError),
      process: {
        residentMemoryBytes: process.memoryUsage().rss,
        uptimeSeconds: process.uptime(),
      },
    });

    return new Response(body, {
      headers: { "content-type": METRICS_CONTENT_TYPE, "cache-control": "no-store" },
    });
  } catch (error) {
    console.error("[api/metrics] read failed", error);

    // The message is not returned: it would be the raw throwable's text, and the
    // health route already reports a classified sentence to the reader who needs it.
    return new Response("", {
      status: 503,
      headers: { "content-type": METRICS_CONTENT_TYPE, "cache-control": "no-store" },
    });
  }
}
