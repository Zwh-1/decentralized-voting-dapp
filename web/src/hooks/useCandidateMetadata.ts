import { useQuery } from "@tanstack/react-query";

import {
  fetchCandidateMetadata,
  metadataStaleTime,
  type CandidateMetadata,
  type MetadataResult,
} from "../lib/ipfs";

/**
 * Loads candidate metadata from IPFS.
 *
 * The result is a discriminated union rather than a nullable value so the UI has
 * to handle each failure mode distinctly: a malformed CID and an unreachable
 * gateway are different problems and should not look the same to a user.
 *
 * `staleTime` is a function of the result rather than one number, because the
 * usual argument for caching forever — metadata is content addressed, so a
 * successful result can never change — does not hold for a failure the network
 * caused. See `metadataStaleTime` and ADR-0018.
 */
export function useCandidateMetadata(cid: string) {
  return useQuery<MetadataResult>({
    queryKey: ["metadata", cid],
    queryFn: () => fetchCandidateMetadata(cid),
    staleTime: (query) => metadataStaleTime(query.state.data),
    retry: false,
  });
}

export type { CandidateMetadata };
