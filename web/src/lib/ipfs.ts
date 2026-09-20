/**
 * Candidate metadata over IPFS, with explicit gateway fallback.
 *
 * This exists because public IPFS gateways are unreliable: during development
 * `ipfs.io` and `dweb.link` both answered HTTP 429 (rate limited). A DApp that
 * assumes one gateway works will show an empty ballot the first time it is
 * throttled, so every gateway is tried in turn with a timeout, and a total
 * failure is a supported state the UI renders deliberately rather than an
 * exception.
 */

export interface CandidateMetadata {
  name: string;
  slogan?: string;
  description?: string;
}

const DEFAULT_GATEWAYS = [
  "https://dweb.link/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
];

const configured = process.env.NEXT_PUBLIC_IPFS_GATEWAY;

const GATEWAYS = configured === undefined ? DEFAULT_GATEWAYS : [configured, ...DEFAULT_GATEWAYS];

const TIMEOUT_MS = 6000;

/**
 * A cheap sanity check before spending a request on a gateway.
 *
 * CIDv0 is 46 characters of base58 starting with `Qm`.
 *
 * CIDv1 in the base32 form is a `b` multibase prefix plus 58 base32 characters,
 * 59 in total. This deliberately does not pin the two characters after `baf`:
 * they encode the codec, and a metadata document can legitimately arrive as
 * dag-pb (`bafy…`), dag-json (`bafy…`) or raw bytes (`bafk…`). Matching only
 * `bafy` rejected the raw form, and because the caller renders a rejected CID as
 * "the CID is malformed", that told the reader their data was corrupt when it was
 * the check that was wrong.
 *
 * Anything else cannot resolve, so it is rejected locally instead of producing
 * one guaranteed 4xx per gateway.
 */
export function isPlausibleCid(cid: string): boolean {
  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid)) {
    return true;
  }

  return /^b[a-z2-7]{58}$/.test(cid);
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export type MetadataResult =
  | { status: "ok"; metadata: CandidateMetadata }
  | { status: "invalid-cid" }
  /** No gateway could be contacted at all: a network problem. */
  | { status: "unreachable"; attempts: number }
  /**
   * A gateway answered, but none served usable candidate metadata for this CID —
   * either a non-2xx (404, 429) or a 2xx whose body is not a metadata document.
   *
   * This is separate from `unreachable` because the two call for different
   * actions, and because conflating them made the UI say the wrong thing. A real
   * run against the live gateways put it plainly: for the well-known
   * `QmT78z…` CID, `dweb.link` and `ipfs.io` never answered while
   * `gateway.pinata.cloud` answered 200 with `hello world` — plain text, not
   * metadata. Reporting that as "3 gateways unreachable" was false about a
   * gateway that had just replied, and it sent the reader to check a network
   * that was working.
   */
  | { status: "no-metadata"; attempts: number; answered: number };

export async function fetchCandidateMetadata(cid: string): Promise<MetadataResult> {
  if (!isPlausibleCid(cid)) {
    return { status: "invalid-cid" };
  }

  let attempts = 0;
  let answered = 0;

  for (const gateway of GATEWAYS) {
    attempts += 1;

    try {
      const response = await fetchWithTimeout(`${gateway}${cid}`);

      if (!response.ok) {
        // Reached the gateway; it declined to serve this CID.
        answered += 1;
        continue;
      }

      answered += 1;

      const parsed = (await response.json()) as Partial<CandidateMetadata>;

      if (typeof parsed.name !== "string" || parsed.name.length === 0) {
        continue;
      }

      return {
        status: "ok",
        metadata: {
          name: parsed.name,
          ...(typeof parsed.slogan === "string" ? { slogan: parsed.slogan } : {}),
          ...(typeof parsed.description === "string" ? { description: parsed.description } : {}),
        },
      };
    } catch {
      // Timeout, network error, or a body that is not JSON. Try the next gateway;
      // whether this counted as an answer is decided above, not here.
      continue;
    }
  }

  if (answered === 0) {
    return { status: "unreachable", attempts };
  }

  return { status: "no-metadata", attempts, answered };
}
