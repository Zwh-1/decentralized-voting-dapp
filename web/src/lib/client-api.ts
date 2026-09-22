// SPDX-License-Identifier: MIT
/** Browser-side client for this app's own API routes. */

import type {
  HealthResponse,
  PollSummary,
  ResultsResponse,
  SyncResponse,
  TallyResponse,
  VoterResponse,
} from "./types";

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });

  if (!response.ok) {
    throw new Error(`${path} responded ${response.status}`);
  }

  return (await response.json()) as T;
}

/** Every poll the factory has created, newest first. */
export interface PollsResponse {
  count: number;
  polls: PollSummary[];
}

export function fetchPolls(signal?: AbortSignal): Promise<PollsResponse> {
  return getJson<PollsResponse>("/api/polls", signal);
}

/** One poll's facts and its tally. `tally` is null when only the tally failed. */
export interface PollResponse {
  poll: PollSummary;
  tally: { source: "chain" | "index"; total: number; options: TallyResponse["options"] } | null;
}

export function fetchPoll(address: string, signal?: AbortSignal): Promise<PollResponse> {
  return getJson<PollResponse>(`/api/polls/${address}`, signal);
}

export function fetchTally(address: string, signal?: AbortSignal): Promise<TallyResponse> {
  return getJson<TallyResponse>(`/api/polls/${address}/tally`, signal);
}

/**
 * `/api/polls/[address]/results` answers 500 when the two sources genuinely
 * disagree — the index has caught up and still reports different numbers.
 *
 * That status is deliberate: a non-2xx is what lets monitoring alert on index
 * divergence. But for this endpoint the body *is* the answer, carrying the full
 * per-option diff. Treating the 500 as a transport failure would throw that
 * payload away and make the UI report "cannot compare (index API unreachable)"
 * at exactly the moment it did compare and found a mismatch, which points the
 * reader at the network instead of at the data.
 *
 * So a 500 that parses as a results body is returned as data. The route's error
 * shape is `{ error, message }`, so a `status` string is what distinguishes the
 * two; anything else still throws.
 */
export async function fetchResults(
  address: string,
  signal?: AbortSignal,
): Promise<ResultsResponse> {
  const path = `/api/polls/${address}/results`;
  const response = await fetch(path, { signal });

  if (response.ok) {
    return (await response.json()) as ResultsResponse;
  }

  if (response.status === 500) {
    const body = (await response.json().catch(() => null)) as ResultsResponse | null;

    if (body !== null && typeof body.status === "string") {
      return body;
    }
  }

  throw new Error(`${path} responded ${response.status}`);
}

export function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return getJson<HealthResponse>("/api/health", signal);
}

export function fetchVoter(
  pollAddress: string,
  voter: string,
  signal?: AbortSignal,
): Promise<VoterResponse> {
  return getJson<VoterResponse>(`/api/polls/${pollAddress}/voters/${voter}`, signal);
}

/**
 * Advances the index by one step, and reports what the step did.
 *
 * The route answers 503 with `{ enabled, error, message }` when it could not
 * write — a database that is down, for instance. The previous version of the
 * sync button awaited a bare `fetch` and never looked at the response, so that
 * failure reached the reader as nothing at all. The message is carried through
 * so the caller can name the party that failed (ADR-0012).
 */
export async function triggerSync(signal?: AbortSignal): Promise<SyncResponse> {
  const response = await fetch("/api/index/sync", { method: "POST", signal });
  const body = (await response.json().catch(() => null)) as
    (SyncResponse & { message?: string }) | null;

  if (!response.ok) {
    throw new Error(body?.message ?? `/api/index/sync responded ${response.status}`);
  }

  if (body === null) {
    throw new Error("/api/index/sync returned no JSON body.");
  }

  return body;
}
