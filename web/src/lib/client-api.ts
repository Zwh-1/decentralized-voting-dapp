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

export function fetchResults(signal?: AbortSignal): Promise<ResultsResponse> {
  return getJson<ResultsResponse>("/api/results", signal);
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
