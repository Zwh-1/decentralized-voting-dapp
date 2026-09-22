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

/**
 * The gateways to try, in order, given the optional configured one.
 *
 * A blank value counts as "not configured", the same reading `preflight.ts` and
 * `seed-sepolia.ts` give an empty variable: a blank line someone thinks is
 * unset must not turn into an instruction to fetch a relative URL.
 *
 * De-duplicated, because the natural thing to configure is one of the defaults —
 * this project pins to Pinata, so `NEXT_PUBLIC_IPFS_GATEWAY` is set to the Pinata
 * gateway. Appending the defaults blindly would then try that host first and
 * again last: one extra request that cannot produce a different answer, and one
 * extra unit in the `attempts` count the failure sentence reports.
 */
export function gatewaysFor(configured: string | undefined): string[] {
  if (configured === undefined || configured.trim() === "") {
    return DEFAULT_GATEWAYS;
  }

  return [...new Set([configured, ...DEFAULT_GATEWAYS])];
}

const GATEWAYS = gatewaysFor(process.env.NEXT_PUBLIC_IPFS_GATEWAY);

/**
 * How long a single gateway gets before it is treated as not answering.
 *
 * Measured against the gateway the metadata of this project is actually pinned
 * to (`gateway.pinata.cloud`), from this machine, for a 180-byte document:
 * repeated fetches took 7.2 s, 3.7 s, 7.0 s, 3.7 s — a 6-second budget, which is
 * what this used to be, turned a working gateway into "unreachable" about half
 * the time. A timeout shorter than the slowest real answer is not a safety
 * limit; it is a source of false reports, and it reported them in the same words
 * a genuinely dead gateway gets.
 *
 * The cost is the other direction, and it is deliberate: three gateways that
 * never answer now take up to 45 s to say so, where they used to take 18. The
 * card renders "读取中…" for that whole time rather than claiming anything, which
 * is the honest trade — a wrong "all gateways are unreachable" sends the reader
 * to check a network that is fine.
 */
const TIMEOUT_MS = 15_000;

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

/**
 * How long a transient metadata failure may be reused before asking again.
 *
 * Short enough that a reader who hits a throttled gateway is not stuck with that
 * answer, long enough that a page which cannot reach any gateway does not retry
 * on every render.
 */
const TRANSIENT_FAILURE_MS = 30_000;

/**
 * Whether another attempt could produce a different answer.
 *
 * The distinction is between a verdict this code reached locally and one the
 * network handed back. `invalid-cid` is the former: the CID's shape is a property
 * of the string, so asking again cannot change it, and caching it is correct.
 * `unreachable` and `no-metadata` are the latter, and public gateways are
 * unreliable by this module's own premise — measured during development as
 * HTTP 429 from both `ipfs.io` and `dweb.link`.
 *
 * The `never` check means a new `MetadataResult` member cannot be added without
 * deciding which kind it is; the previous version of this decision did not exist
 * at all, and every failure was cached as though it were permanent.
 */
export function isRetryableMetadata(result: MetadataResult | undefined): boolean {
  if (result === undefined) {
    return false;
  }

  switch (result.status) {
    case "ok":
      return false;
    case "invalid-cid":
      return false;
    case "unreachable":
    case "no-metadata":
      return true;
    default: {
      const exhaustive: never = result;

      return exhaustive;
    }
  }
}

/**
 * How long a result stays fresh, in the sense TanStack Query uses.
 *
 * `ok` is immune to change because metadata is content addressed: the bytes a CID
 * names are fixed by the CID, so re-fetching them can only waste a request. That
 * argument was already written down where this was configured — but it was
 * applied to *every* result, including the failures, which the query function
 * resolves rather than rejects. One throttled gateway therefore pinned
 * "no usable candidate metadata" to the candidate for the rest of the session,
 * and the card offered no way out. A failure the network caused now expires; a
 * verdict this code reached locally does not.
 */
export function metadataStaleTime(result: MetadataResult | undefined): number {
  if (result === undefined) {
    return 0;
  }

  return isRetryableMetadata(result) ? TRANSIENT_FAILURE_MS : Number.POSITIVE_INFINITY;
}

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
