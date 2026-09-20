import { useQuery } from "@tanstack/react-query";

import { fetchCandidateMetadata, type CandidateMetadata, type MetadataResult } from "../lib/ipfs";

/**
 * Loads candidate metadata from IPFS.
 *
 * The result is a discriminated union rather than a nullable value so the UI has
 * to handle each failure mode distinctly: a malformed CID and an unreachable
 * gateway are different problems and should not look the same to a user.
 */
export function useCandidateMetadata(cid: string) {
  return useQuery<MetadataResult>({
    queryKey: ["metadata", cid],
    queryFn: () => fetchCandidateMetadata(cid),
    // Metadata is content addressed, so a successful result can never change.
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

export type { CandidateMetadata };
