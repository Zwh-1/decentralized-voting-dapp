/** Typed client for the read-only indexer API. */

export interface ApiCandidate {
  id: number;
  metadataCid: string;
  voteCount: number;
}

export interface CandidatesResponse {
  total: number;
  candidates: ApiCandidate[];
}

export interface Discrepancy {
  candidateId: number;
  onChain: number | null;
  indexed: number | null;
}

export interface ResultsResponse {
  consistent: boolean;
  onChainTotal: number;
  indexedTotal: number;
  discrepancies: Discrepancy[];
  onChain: CandidatesResponse;
  indexed: CandidatesResponse;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  chainId: number;
  contract: string;
  confirmations: number;
  lastIndexedBlock: string | null;
  chainHead: string | null;
  lagBlocks: string | null;
}

export interface VoterResponse {
  address: string;
  whitelisted: boolean | null;
  hasVoted: boolean;
  votedFor: number | null;
  voteTxHash: string | null;
  refunds: { amountWei: string; txHash: string }[];
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });

  if (!response.ok) {
    throw new Error(`${path} responded ${response.status}`);
  }

  return (await response.json()) as T;
}

export function fetchCandidates(signal?: AbortSignal): Promise<CandidatesResponse> {
  return getJson<CandidatesResponse>("/api/candidates", signal);
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
