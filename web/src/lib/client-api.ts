// SPDX-License-Identifier: MIT
/** Browser-side client for this app's own API routes. */

import type { HealthResponse, ResultsResponse, TallyResponse, VoterResponse } from "./types";

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });

  if (!response.ok) {
    throw new Error(`${path} responded ${response.status}`);
  }

  return (await response.json()) as T;
}

export function fetchTally(signal?: AbortSignal): Promise<TallyResponse> {
  return getJson<TallyResponse>("/api/candidates", signal);
}

/**
 * `/api/results` answers 500 when the two sources disagree.
 *
 * That status is deliberate — a non-2xx is what lets monitoring alert on index
 * divergence — but for this endpoint the body *is* the answer: it carries the
 * full per-candidate diff. Treating the 500 as a transport failure would throw
 * that payload away and make the UI report "cannot compare (index API
 * unreachable)" at exactly the moment it did compare and found a mismatch,
 * which points the reader at the network instead of at the data.
 *
 * So a 500 that parses as a results body is returned as data; anything else
 * still throws.
 */
export async function fetchResults(signal?: AbortSignal): Promise<ResultsResponse> {
  const response = await fetch("/api/results", { signal });

  if (response.ok) {
    return (await response.json()) as ResultsResponse;
  }

  if (response.status === 500) {
    const body = (await response.json().catch(() => null)) as ResultsResponse | null;

    if (body !== null && typeof body.consistent === "boolean") {
      return body;
    }
  }

  throw new Error(`/api/results responded ${response.status}`);
}

export function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return getJson<HealthResponse>("/api/health", signal);
}

export function fetchVoter(address: string, signal?: AbortSignal): Promise<VoterResponse> {
  return getJson<VoterResponse>(`/api/voters/${address}`, signal);
}

/** Advances the index by one step. */
export async function triggerSync(): Promise<void> {
  await fetch("/api/index/sync", { method: "POST" });
}
