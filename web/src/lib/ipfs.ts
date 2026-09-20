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
 * CIDv0 is 46 characters starting with `Qm`; CIDv1 in the common base32 form is
 * 59 characters starting with `bafy`. Anything else cannot resolve, so it is
 * rejected locally instead of producing three guaranteed 4xx responses.
 */
export function isPlausibleCid(cid: string): boolean {
  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid)) {
    return true;
  }

  return /^bafy[a-z2-7]{55}$/.test(cid);
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
  | { status: "unreachable"; attempts: number };

export async function fetchCandidateMetadata(cid: string): Promise<MetadataResult> {
  if (!isPlausibleCid(cid)) {
    return { status: "invalid-cid" };
  }

  let attempts = 0;

  for (const gateway of GATEWAYS) {
    attempts += 1;

    try {
      const response = await fetchWithTimeout(`${gateway}${cid}`);

      if (!response.ok) {
        continue;
      }

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
      // Timeout or network error: try the next gateway.
      continue;
    }
  }

  return { status: "unreachable", attempts };
}
