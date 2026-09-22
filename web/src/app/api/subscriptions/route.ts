// SPDX-License-Identifier: MIT
import { NextResponse } from "next/server";

import { listSubscriptions, subscribe, unsubscribe } from "@/lib/data";
import { describeFailure } from "@/lib/failure";
import { parseAddressParam, parseSubscriptionRequest } from "@/lib/notify";

export const dynamic = "force-dynamic";

const NO_INDEX = {
  error: "index_unavailable",
  message:
    "This deployment has no usable index, so subscriptions cannot be stored. " +
    "They are not missing — they are unavailable.",
};

/**
 * Subscriptions: which polls one address asked to be told about.
 *
 * ---------------------------------------------------------------------------
 * There is no authentication here, and that is a stated limitation
 * ---------------------------------------------------------------------------
 *
 * `address` comes from the caller and is not proven. This app has no accounts and
 * no sessions, so anyone can subscribe any address, and anyone can read any
 * address's subscription list.
 *
 * That is tolerable only because of what the data IS. A subscription says "address
 * A follows poll P", and a notification derived from it says "poll P had a refund
 * at block N" — every word of which is already public on chain. So the worst a
 * forged subscription achieves is showing a reader a poll they did not ask about.
 *
 * The rule that follows, and the one that must not be relaxed: a subscription is a
 * HINT, not an authorisation. Nothing is gated on holding one, and nothing
 * private may ever be attached to one.
 *
 * ---------------------------------------------------------------------------
 * Why 404 when there is no index
 * ---------------------------------------------------------------------------
 *
 * Same reasoning as the audit feed: "no index" and "you follow nothing" are
 * different facts, and answering the first with an empty list would tell a reader
 * their subscriptions are gone.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;

  const parsed = parseAddressParam(params.get("address"));

  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, message: parsed.message }, { status: 400 });
  }

  try {
    const subscriptions = await listSubscriptions(parsed.address);

    if (subscriptions === null) {
      return NextResponse.json(NO_INDEX, { status: 404 });
    }

    return NextResponse.json({ address: parsed.address, source: "index", subscriptions });
  } catch (error) {
    console.error("[api/subscriptions] read failed", error);

    return NextResponse.json(
      { error: "upstream_unavailable", message: describeFailure(error) },
      { status: 503 },
    );
  }
}

/** Adds a subscription. Idempotent: subscribing twice is not an error. */
export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Expected a JSON object." },
      { status: 400 },
    );
  }

  const parsed = parseSubscriptionRequest(body);

  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, message: parsed.message }, { status: 400 });
  }

  try {
    const stored = await subscribe(parsed.address, parsed.poll);

    if (!stored) {
      return NextResponse.json(NO_INDEX, { status: 404 });
    }

    return NextResponse.json({
      address: parsed.address,
      poll: parsed.poll,
      subscribed: true,
    });
  } catch (error) {
    console.error("[api/subscriptions] write failed", error);

    return NextResponse.json(
      { error: "upstream_unavailable", message: describeFailure(error) },
      { status: 503 },
    );
  }
}

/**
 * Removes a subscription.
 *
 * `DELETE` takes its arguments as a query string rather than a body, because a
 * body on `DELETE` is not universally handled and a fetch with one is easy to get
 * wrong. Unsubscribing something that was never subscribed is a success, not a
 * 404: the caller's intent is satisfied either way, and reporting a failure would
 * make a retry look like a bug.
 */
export async function DELETE(request: Request) {
  const params = new URL(request.url).searchParams;
  const parsed = parseSubscriptionRequest({
    address: params.get("address")?.trim() ?? "",
    poll: params.get("poll")?.trim() ?? "",
  });

  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, message: parsed.message }, { status: 400 });
  }

  try {
    const removed = await unsubscribe(parsed.address, parsed.poll);

    if (!removed) {
      return NextResponse.json(NO_INDEX, { status: 404 });
    }

    return NextResponse.json({ address: parsed.address, poll: parsed.poll, subscribed: false });
  } catch (error) {
    console.error("[api/subscriptions] delete failed", error);

    return NextResponse.json(
      { error: "upstream_unavailable", message: describeFailure(error) },
      { status: 503 },
    );
  }
}
