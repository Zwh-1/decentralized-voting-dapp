// SPDX-License-Identifier: MIT
/**
 * Drives the browser against the running app with an injected wallet and checks
 * that the UI agrees with the chain.
 *
 * Why this exists: two real defects lived in exactly the surface nothing else
 * covered. `receipt.isPending` is permanently true while no transaction has been
 * sent — wagmi disables the receipt query without a hash and a disabled TanStack
 * query still reports `status: "pending"` — so every vote button read "提交中…"
 * and, because the button is disabled while submitting, could not be clicked at
 * all. And the vote button never consulted the whitelist, so it invited a
 * transaction the contract was certain to reject. Neither is visible to a type
 * check, a build, an SSR fetch or an indexer test: they only appear once a wallet
 * is connected in a real DOM.
 *
 *   pnpm ui:drill
 *
 * It runs headless Chrome over the DevTools Protocol, so it needs no browser
 * automation dependency — Node 22+ ships the `WebSocket` it uses. The injected
 * provider forwards `eth_sendTransaction` to the node, which signs with its own
 * unlocked account, so no private key is handled here.
 *
 * `TEST_ACCOUNT` selects the account to connect as. The drill reads that
 * account's `isWhitelisted`, `phase`, `stakeOf` and `voterState` straight from the
 * chain and asserts the rendered buttons match, so it is correct whether the
 * account can vote, change, or refund, and whether it can do none of them. With
 * `--vote` it additionally clicks through a real vote; with `--change` a real
 * 改投; with `--refund` a real refund. All three wait for the receipt.
 *
 * `--change` needs an account that already has a vote, so run `--vote` first (or
 * point `TEST_ACCOUNT` at one that has voted). It is the mode that covers this
 * project's newest capability end to end: the button, a signed transaction, the
 * vote moving on chain, and the stake not being charged twice.
 *
 * With `--reject` the injected wallet refuses `eth_sendTransaction` with EIP-1193
 * code 4001 — the shape of a reader clicking 拒绝 in their wallet — and the drill
 * asserts the page says so in Chinese and that the chain is untouched. Nothing is
 * broadcast in that mode, so unlike `--vote` / `--change` / `--refund` it is safe
 * against any chain. See ADR-0022.
 *
 * Read-only by default: it never mutates the chain. Use `--vote` / `--change` /
 * `--refund` only against a chain where that is acceptable, or under a snapshot.
 * Those flags are also the only reason the drill used to insist on the local
 * network — a run without them clicks nothing, so it can be pointed at any chain,
 * including a deployed one, by setting `CHAIN_ID` / `RPC_URL` in `web/.env` and
 * `APP_URL`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createPublicClient, defineChain, http } from "viem";

import { loadServerConfig } from "../src/lib/config";
import { factoryAbi, pollAbi } from "../src/lib/contracts";
import { isPlausibleCid } from "../src/lib/ipfs";
import { formatEth } from "../src/lib/voting";
import { CdpBrowser, DEBUG_PORT, shorten, sleep } from "./lib/cdp";

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter((value): value is string => typeof value === "string" && value.length > 0);

const APP_URL = process.env.APP_URL ?? "http://127.0.0.1:3100/";
const VOTE = process.argv.includes("--vote");
const CHANGE = process.argv.includes("--change");
const REFUND = process.argv.includes("--refund");
const REJECT = process.argv.includes("--reject");
const SHOT = process.env.SHOT ?? "";

const config = loadServerConfig();

// Guards run before any child process or temp directory exists, so `process.exit`
// has no resource to race with here. Every exit after that uses `process.exitCode`
// and lets the `finally` block clean up.
//
// The chain restriction is about *writes*, not reads. The injected provider
// forwards whatever the page asks for to the configured RPC, and a local Hardhat
// node signs `eth_sendTransaction` with its own unlocked account; a public network
// would have nobody to sign. A run without `--vote` / `--change` / `--refund`
// clicks nothing, so it is read-only and may point at any chain — which is what
// lets the same assertions be run against a deployed ballot (Sepolia, say) instead
// of only a local node.
if ((VOTE || CHANGE || REFUND) && config.chainId !== 31337) {
  console.error(
    `Refusing to run: --vote, --change and --refund send real transactions, and only the local ` +
      `Hardhat network (31337) signs them. CHAIN_ID is ${config.chainId}. Drop those flags to check ` +
      `the rendering read-only against this chain.`,
  );
  process.exit(1);
}

const account = (process.env.TEST_ACCOUNT ??
  "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266") as `0x${string}`;

const chain = defineChain({
  id: config.chainId,
  name: `chain-${config.chainId}`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
});

const client = createPublicClient({ chain, transport: http(config.rpcUrl) });

/**
 * The poll this drill drives the UI for, and the page that shows it.
 *
 * Discovered from the factory rather than configured: the app's own list page is
 * reached at `/`, but every voting control lives on `/poll/<address>`, and a
 * hardcoded address would keep "working" against a poll that no longer exists
 * after any redeploy — the drill would then be asserting against a page that
 * cannot read its contract, and every read-failure branch would pass for the
 * wrong reason.
 *
 * `POLL_ADDRESS` overrides the discovery, which is what a CI job wants when it
 * needs the drill to target a specific poll.
 */
const pollAddress: `0x${string}` = await (async (): Promise<`0x${string}`> => {
  const explicit = process.env.POLL_ADDRESS;

  if (explicit !== undefined && explicit.length > 0) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(explicit)) {
      throw new Error("POLL_ADDRESS must be a 20 byte hex address.");
    }

    return explicit as `0x${string}`;
  }

  const all = await client.readContract({
    address: config.factoryAddress,
    abi: factoryAbi,
    functionName: "allPolls",
  });

  const first = all[0];

  if (first === undefined) {
    throw new Error(
      "The factory has created no polls, so there is no ballot page to drill. " +
        "Run `pnpm seed:local` first (or set POLL_ADDRESS).",
    );
  }

  return first;
})();

/** The poll's own page, which is where every voting control lives. */
const POLL_URL = new URL(`/poll/${pollAddress}`, APP_URL).toString();

interface ButtonState {
  text: string;
  disabled: boolean;
  title: string | null;
}

interface PageState {
  buttons: ButtonState[];
  hasSubmittingLabel: boolean;
  whitelistRow: string | null;
  /** The 可投票 row, which every poll shows whatever its admission mode. */
  canVoteRow: string | null;
  /** The 准入方式 row, shown only on an open poll. */
  modeRow: string | null;
  stakeRow: string | null;
  /** Did the "我的状态" heading the row reads start from exist at all? */
  panelFound: boolean;
  /** Did the panel have a closing boundary, or did the slice run to page end? */
  panelBounded: boolean;
  /** How many option cards report `data-option-mine="true"`. */
  myOptionButtons: number;
  /** The text of each option's action button, for failure messages. */
  voteButtonTexts: string[];
  /** How many option action controls the ballot rendered, one per option. */
  optionActionCount: number;
  refundReason: string | null;
  ipfsLabels: string[];
  /** Per IPFS row, in the same order as `ipfsLabels`: the CID that row is about. */
  metadataCids: string[];
  /** Per IPFS row, in the same order as `ipfsLabels`: does it offer a retry? */
  ipfsRetries: boolean[];
  /** Per option card, in DOM order: the heading the card is currently showing. */
  cardNames: string[];
  cardCount: number;
  /** True while any row on the page still says it is reading. */
  pending: boolean;
  connected: boolean;
  hasProvider: boolean;
  connectError: string | null;
  /**
   * The write path's own error line, read by its data attribute rather than by
   * matching the sentence: `classified` means the app identified who refused,
   * `unclassified` means it declined to guess. Both the text and the flag are
   * asserted, so neither a leaked English string nor a wrongly confident
   * sentence can pass.
   */
  writeError: string | null;
  writeErrorKind: string | null;
  walletMethods: string[];
  /** The 运行状态 panel's toggle is present at all. */
  healthToggleFound: boolean;
  /** The panel is expanded and rendering its rows. */
  healthRowsFound: boolean;
  /** How many rows it rendered, so "expanded but empty" cannot pass. */
  healthRowCount: number;
  /** The 活动记录 panel's toggle is on the page. */
  activityToggleFound: boolean;
  /** The panel is expanded and rendering its list container. */
  activityPanelFound: boolean;
  /** How many event rows it rendered. */
  activityRowCount: number;
  /** The skeleton is showing: the query has not settled. */
  activityLoadingFound: boolean;
  /** The query settled and the poll genuinely has no events. */
  activityEmptyFound: boolean;
  /** The query settled and this deployment has no index. */
  activityUnavailableFound: boolean;
  /** The query settled with a failure. */
  activityErrorFound: boolean;
  /** The total the panel states, to check the list against. */
  activityStated: number | null;
  /** The CSV download link's href, or null when the control is missing. */
  exportCsvHref: string | null;
  /** The JSON download link's href. */
  exportJsonHref: string | null;
  /** The rules verdict the panel reached: unchanged / changed / unknown / pending. */
  rulesVerdict: string | null;
  /** The creation-time fingerprint as displayed. */
  rulesCommitted: string | null;
  /** The live recomputation as displayed. */
  rulesCurrent: string | null;
  /** The stake-risk panel is rendered. */
  stakeRiskFound: boolean;
}

/** The provider injected before any page script, so wagmi sees a wallet. */
function walletSource(
  rpcUrl: string,
  address: `0x${string}`,
  chainIdHex: string,
  rejectSends: boolean,
): string {
  return `
(() => {
  const RPC = ${JSON.stringify(rpcUrl)};
  const ACCOUNT = ${JSON.stringify(address)};
  const CHAIN_ID_HEX = ${JSON.stringify(chainIdHex)};
  // Refuses the signature the way a wallet does when the reader clicks 拒绝:
  // EIP-1193 code 4001, raised at eth_sendTransaction. Reads still work, so the
  // page behaves exactly as it does in front of a real wallet. Nothing is
  // broadcast, which is what makes this mode safe on a deployed chain.
  const REJECT_SENDS = ${rejectSends ? "true" : "false"};
  let id = 1;
  const listeners = {};
  window.__walletCalls = [];
  async function forward(method, params) {
    window.__walletCalls.push(method);
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params: params ?? [] }),
    });
    const body = await res.json();
    if (body.error) {
      const err = new Error(body.error.message);
      err.code = body.error.code;
      err.data = body.error.data;
      throw err;
    }
    return body.result;
  }
  const provider = {
    isMetaMask: true,
    chainId: CHAIN_ID_HEX,
    selectedAddress: ACCOUNT,
    async request({ method, params }) {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [ACCOUNT];
      if (method === "wallet_requestPermissions") return [{ parentCapability: "eth_accounts" }];
      if (method === "wallet_getPermissions") return [{ parentCapability: "eth_accounts" }];
      if (method.startsWith("wallet_")) return null;
      if (REJECT_SENDS && method === "eth_sendTransaction") {
        window.__walletCalls.push(method + ":refused");
        const refusal = new Error("User rejected the request.");
        refusal.code = 4001;
        throw refusal;
      }
      return forward(method, params);
    },
    on(event, handler) { (listeners[event] ??= []).push(handler); return provider; },
    removeListener(event, handler) {
      listeners[event] = (listeners[event] ?? []).filter((h) => h !== handler);
      return provider;
    },
  };
  Object.defineProperty(window, "ethereum", { value: provider, configurable: true });
  window.dispatchEvent(new Event("ethereum#initialized"));
})();
`;
}

const READ_PAGE = `(() => {
  const buttons = [...document.querySelectorAll('button')].map((b) => ({
    text: b.textContent.trim(), disabled: b.disabled, title: b.title || null,
  }));
  const text = document.body.innerText;
  // Where the "我的状态" panel begins and ends, in the page's innerText. These
  // bound the panel for the assertion below, which checks that the boundary is
  // real: the headings render as "我的状态" and "选项（<n>）", and a rename that
  // broke either literal would leave the index at -1 and quietly let the slice
  // run to the end of the page. No backticks in this comment: it lives inside a
  // template literal.
  const panelStart = text.indexOf('我的状态');
  const optionsHeading = text.indexOf('选项（');
  const panelEnd = optionsHeading < 0 ? text.indexOf('选项') : optionsHeading;
  // Reads the value of a labeled row, by DOM structure.
  //
  // This used to be a substring search over the panel's innerText, which broke
  // the moment two different rows' text overlapped: a disabled button's reason
  // sentence contains the word 白名单, so searching for that label found the
  // REASON and reported the next line of prose as if it were the row's value —
  // the assertion then compared 已投票 against isWhitelisted and failed while the
  // page was correct. Anchoring on the <dt> element means only a real label can
  // match. No backticks in this comment: it lives inside a template literal.
  const rowAfter = (label) => {
    const dt = [...document.querySelectorAll('dt')].find(
      (node) => node.textContent.trim() === label,
    );
    if (!dt) return null;
    return dt.parentElement?.querySelector('dd')?.textContent.trim() ?? null;
  };
  // The refund reason is a <span> sibling of the refund button inside the same
  // row. Read it from the DOM rather than from a line of innerText: the reason
  // renders on its own line, so a text search finds only the button label and
  // the assertion would pass even with no reason at all.
  const refundBtn = [...document.querySelectorAll('button')].find((b) =>
    b.textContent.includes('取回押金'),
  );
  const refundReason = refundBtn
    ? [...refundBtn.parentElement.querySelectorAll('span')]
        .map((s) => s.textContent.trim())
        .filter(Boolean)
        .join(' ') || null
    : null;
  // One IPFS row per option card. Read the <dd> next to the <dt>IPFS</dt>
  // rather than searching innerText, so a card that renders nothing at all shows
  // up as an empty string instead of being silently absent from the results.
  // The retry control is a sibling of the <dd>, so this text stays the card's
  // stated outcome and does not grow a button label.
  const ipfsRows = [...document.querySelectorAll('dt')].filter(
    (dt) => dt.textContent.trim() === 'IPFS',
  );
  const ipfsLabels = ipfsRows.map(
    (dt) => dt.parentElement?.querySelector('dd')?.textContent.trim() ?? '',
  );
  // Whether the card offers to ask again. A data attribute rather than the button
  // text, which reads "重试" or "重试中…" depending on state.
  const ipfsRetries = ipfsRows.map(
    (dt) => dt.parentElement?.querySelector('[data-metadata-retry]') !== null,
  );
  // The CID each IPFS row is about, read from the sibling row inside the same
  // card. Without it the drill can only check that the sentence is one of the
  // known ones; with it, the sentence can be compared against the string it
  // describes, which is the check that would have caught the seeded ballot whose
  // CID was not a CID.
  const metadataCids = ipfsRows.map((dt) => {
    const card = dt.parentElement?.parentElement;
    const label = [...(card?.querySelectorAll('dt') ?? [])].find(
      (other) => other.textContent.trim() === '元数据 CID',
    );
    return label?.parentElement?.querySelector('dd')?.textContent.trim() ?? '';
  });
  // The number of cards, counted independently of the IPFS rows so the two can be
  // compared. Deliberately NOT derived from the vote buttons: their text changes
  // with the phase ("投一票" becomes "你已投给该候选人" once you have voted), so a
  // button-text filter yields a different count per scenario.
  const cardCount = [...document.querySelectorAll('dt')].filter(
    (dt) => dt.textContent.trim() === '元数据 CID',
  ).length;
  // The name each card is showing. "已解析" alone proves the document arrived but
  // not that anything of it is on screen: the card falls back to a numbered
  // heading ("选项 #<id>") for every outcome that is not ok, so a card that
  // resolved and still rendered the number would satisfy every other assertion
  // here. No backticks in this comment: it lives inside a template literal.
  const cardNames = [...document.querySelectorAll('dt')]
    .filter((dt) => dt.textContent.trim() === '元数据 CID')
    .map((dt) => dt.closest('article')?.querySelector('h3')?.textContent.trim() ?? '');
  // The write path's error line, located by the attribute the component sets so
  // this read cannot drift into picking up some other rose-coloured text.
  const writeErrorNode = document.querySelector('[data-write-error]');
  // Whether each option is the one this account currently backs, read from the
  // attribute the component sets for exactly that fact.
  //
  // The option this account backs renders its button as "你当前投给了这个选项" and
  // offers no action; every other option offers \`vote\` before a vote exists and
  // \`change\` afterwards. Asserting on that wording is what broke when the ballot
  // became multi-tenant — the old sentence no longer existed, so the assertion
  // could never pass and had quietly stopped being a check. The attribute does not
  // move when the wording does.
  const myOptionButtons = document.querySelectorAll('[data-option-mine="true"]').length;
  const voteButtonTexts = [...document.querySelectorAll('[data-option-action]')].map((b) =>
    b.textContent.trim(),
  );
  // One entry per option, whatever that option's control currently offers.
  const optionActionCount = voteButtonTexts.length;
  return {
    buttons,
    hasSubmittingLabel: text.includes('提交中…'),
    whitelistRow: rowAfter('白名单'),
    canVoteRow: rowAfter('可投票'),
    modeRow: rowAfter('准入方式'),
    stakeRow: rowAfter('押金'),
    // Both ends of the "我的状态" panel, so the drill can assert that the slice it
    // reads the rows out of is actually a slice. Without these, a renamed heading
    // makes the panel silently run to the end of the page and every row assertion
    // keeps passing against a much larger body of text.
    panelFound: panelStart >= 0,
    panelBounded: panelStart >= 0 && panelEnd > panelStart,
    myOptionButtons,
    voteButtonTexts,
    optionActionCount,
    refundReason,
    ipfsLabels,
    metadataCids,
    ipfsRetries,
    cardNames,
    cardCount,
    pending: text.includes('读取中…'),
    connected: buttons.some((b) => b.text === '断开'),
    hasProvider: typeof window.ethereum !== 'undefined',
    // Read by its own hook rather than by a colour class. The previous selector
    // matched any red text, so it silently picked up the whitelist row showing
    // "否" and reported that as the wallet connect error.
    connectError: document.querySelector('[data-connect-error]')?.textContent?.trim() ?? null,
    writeError: writeErrorNode ? writeErrorNode.textContent.trim() : null,
    writeErrorKind: writeErrorNode ? writeErrorNode.getAttribute('data-write-error') : null,
    walletMethods: [...new Set(window.__walletCalls ?? [])],
    // The 运行状态 panel. It is collapsed by default, so these are read after the
    // drill opens it — see the health assertions below. Without this the panel
    // could regress to rendering nothing and every other assertion would still
    // pass, which is precisely how the health endpoint went unshown at first.
    healthToggleFound: document.querySelector('[data-testid="health-toggle"]') !== null,
    healthRowsFound: document.querySelector('[data-testid="health-rows"]') !== null,
    healthRowCount: document.querySelectorAll('[data-testid="health-rows"] > div').length,
    // The 活动记录 panel and the export controls. Both are on the poll page and
    // both are collapsed or inert until used, so reading the page as loaded would
    // pass even if they rendered nothing — the same trap the health panel note
    // above describes.
    activityToggleFound: document.querySelector('[data-testid="activity-toggle"]') !== null,
    activityPanelFound: document.querySelector('[data-testid="activity-panel"]') !== null,
    activityRowCount: document.querySelectorAll('[data-activity-kind]').length,
    // The settled states. These exist because a row count of zero cannot
    // distinguish "still fetching" from "answered, with nothing to show", and
    // the drill has to tell them apart to avoid reading mid-load.
    activityLoadingFound: document.querySelector('[data-testid="activity-loading"]') !== null,
    activityEmptyFound: document.querySelector('[data-testid="activity-empty"]') !== null,
    activityUnavailableFound:
      document.querySelector('[data-testid="activity-unavailable"]') !== null,
    activityErrorFound: document.querySelector('[data-testid="activity-error"]') !== null,
    // The panel's own reported total, which is what the row count is checked
    // against: a list that silently truncates would otherwise pass a "> 0" test.
    activityStated: (() => {
      const panel = document.querySelector('[data-testid="activity-panel"]');
      if (!panel) return null;
      const m = (panel.textContent || '').match(/共 (\\d+) 条记录/);
      return m ? Number(m[1]) : null;
    })(),
    exportCsvHref: document.querySelector('[data-export="csv"]')?.getAttribute('href') ?? null,
    exportJsonHref: document.querySelector('[data-export="json"]')?.getAttribute('href') ?? null,
    // The 规则指纹 panel and the verdict it reached. Read as the attribute
    // rather than the sentence, so a wrong verdict cannot pass by being worded
    // correctly.
    rulesVerdict:
      document.querySelector('[data-rules-verdict]')?.getAttribute('data-rules-verdict') ?? null,
    rulesCommitted:
      document.querySelector('[data-fingerprint="创建时的承诺"]')?.textContent?.trim() ?? null,
    rulesCurrent:
      document.querySelector('[data-fingerprint="当前状态重算"]')?.textContent?.trim() ?? null,
    stakeRiskFound: document.querySelector('[data-testid="stake-risk"]') !== null,
  };
})()`;

// The CDP transport lives in `scripts/lib/cdp.ts`; see that file for why a raw
// socket is used rather than a driver library. What stays here is everything that
// interprets the page: the assertions, the fake wallet, and the read expression.
const browser = new CdpBrowser(DEBUG_PORT);
const browserMessages = browser.messages;

/** Reads the page once it has stopped loading anything. */
async function settled(sessionId: string, budgetMs: number): Promise<PageState> {
  const deadline = Date.now() + budgetMs;
  let state = await browser.evaluate<PageState>(sessionId, READ_PAGE);

  while (Date.now() < deadline && state.pending) {
    await sleep(500);
    state = await browser.evaluate<PageState>(sessionId, READ_PAGE);
  }

  return state;
}

async function main(): Promise<number> {
  const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));

  if (chromePath === undefined) {
    console.error(
      "Could not find Chrome. Set CHROME_PATH to the executable (looked at:\n  " +
        CHROME_CANDIDATES.join("\n  ") +
        ")",
    );
    return 1;
  }

  const profile = mkdtempSync(path.join(tmpdir(), "voting-ui-drill-"));
  let chrome: ChildProcess | undefined;
  let failures = 0;

  const check = (label: string, ok: boolean, detail = ""): void => {
    if (!ok) failures += 1;
    console.log(`  ${ok ? "OK  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  };

  try {
    chrome = spawn(
      chromePath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${profile}`,
        `--remote-debugging-port=${DEBUG_PORT}`,
        "about:blank",
      ],
      // Piped stdio is not available in every sandbox; this drill never reads it.
      { stdio: "ignore" },
    );

    // Built in Node rather than inside the injected template: `31337.toString(16)`
    // is a SyntaxError, and a broken injected script fails silently, leaving the
    // page with no wallet and the drill chasing the wrong symptom.
    const chainIdHex = `0x${config.chainId.toString(16)}`;
    const sessionId = await browser.openPage({
      source: walletSource(config.rpcUrl, account, chainIdHex, REJECT),
      url: POLL_URL,
    });

    // What the chain says, read independently of the page.
    //
    // `voterState` answers all four questions in one call. Four separate getters
    // would let this snapshot mix two blocks — "has voted" from one and "voted
    // for 0" from the next — and the drill compares this against a page that read
    // its own single-block state, so a torn read here would show up as a UI
    // disagreement that is really a measurement artifact.
    const [isWhitelisted, phase, stake, voter] = await Promise.all([
      client.readContract({
        address: pollAddress,
        abi: pollAbi,
        functionName: "isWhitelisted",
        args: [account],
      }),
      client.readContract({
        address: pollAddress,
        abi: pollAbi,
        functionName: "phase",
      }),
      client.readContract({
        address: pollAddress,
        abi: pollAbi,
        functionName: "stakeOf",
        args: [account],
      }),
      client.readContract({
        address: pollAddress,
        abi: pollAbi,
        functionName: "voterState",
        args: [account],
      }),
    ]);

    // `voterState` returns (whitelisted, currentOptionId, stake, marked, canVote).
    // "Has voted" is no longer a boolean on chain: a voter can withdraw, so the
    // question is whether an option is currently backed.
    const hasVoted = voter[1] !== 0n;
    // Which option the chain says this account backs, or null for none. Read from
    // the same tuple as `hasVoted`, so the two can never disagree about which
    // block they describe.
    const votedForOption: number | null = voter[1] === 0n ? null : Number(voter[1]);

    const PHASE_VOTING = 1;
    const PHASE_ENDED = 2;
    const STAKE_WEI = 1_000_000_000_000_000n;

    // Whether the poll admits everyone is read from the poll, not inferred from
    // `isWhitelisted`. On an open poll that getter is `false` for every address
    // including admitted ones, so an assertion built on it alone would demand a
    // disabled vote button on a poll where everyone may vote — which is exactly
    // the false failure this drill produced the first time it met an open poll.
    const openToAll = await client.readContract({
      address: pollAddress,
      abi: pollAbi,
      functionName: "openToAll",
    });
    // `voterState`'s fifth field is the contract's own answer to "may this address
    // vote", so the drill asserts against the authority rather than re-deriving
    // the rule. Reading it also keeps the check honest if the rule changes again.
    const chainSaysCanVote = voter[4];
    const chainSaysVotable = chainSaysCanVote && !hasVoted && Number(phase) === PHASE_VOTING;
    const chainSaysRefundable = Number(phase) === PHASE_ENDED && stake > 0n;

    console.log(`\naccount          ${account}`);
    console.log(
      `chain            openToAll=${openToAll}  isWhitelisted=${isWhitelisted}  canVote=${chainSaysCanVote}` +
        `  hasVoted=${hasVoted}  phase=${phase}  stakeOf=${stake} wei`,
    );
    console.log(`app              ${POLL_URL}\n`);

    // Fail loudly if the injection did not take. A silently broken injected
    // script leaves the page wallet-less, and every assertion below would then
    // pass or fail for reasons that have nothing to do with the app.
    const providerPresent = await browser.evaluate<boolean>(
      sessionId,
      `typeof window.ethereum !== 'undefined'`,
    );
    if (!providerPresent) {
      console.error(
        "The injected wallet never reached the page, so the checks below would be " +
          "meaningless. This is a fault in the drill, not in the app.",
      );
      return 1;
    }

    // Connect explicitly. wagmi does not adopt an injected provider on its own —
    // a fresh browser profile has no persisted connector state, so without this
    // the page stays disconnected and every vote button is disabled for the
    // uninteresting reason.
    const connectClick = await browser.evaluate<string>(
      sessionId,
      `(() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '连接钱包');
        if (!b) return 'already-connected';
        b.click();
        return 'clicked';
      })()`,
    );

    const connectDeadline = Date.now() + 20_000;
    let connected = false;
    while (Date.now() < connectDeadline && !connected) {
      await sleep(500);
      connected = await browser.evaluate<boolean>(
        sessionId,
        `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '断开')`,
      );
    }
    console.log(
      `\nconnect: ${connectClick} -> ${connected ? "connected" : "still disconnected"}\n`,
    );

    const metadataStarted = Date.now();
    const before = await settled(sessionId, 90_000);
    console.log(
      `metadata         ${before.ipfsLabels.join(" / ")}  (settled in ${Date.now() - metadataStarted} ms)`,
    );
    console.log(`names            ${before.cardNames.join(" / ")}\n`);
    console.log(
      `diagnostics: provider injected=${before.hasProvider}` +
        `  connectError=${JSON.stringify(before.connectError)}` +
        `  walletMethods=${JSON.stringify(before.walletMethods)}\n`,
    );
    // The ballot's option controls, counted by the component's own attribute
    // rather than by button wording. Counting `投一票` made this vacuous once the
    // account had already voted: the vote button is not rendered at all then, so
    // the count was 0, `voteButtons.length > 0` failed, and the *next* assertion
    // ("enabled exactly when the chain allows it") compared 0 against 0 and passed
    // without testing anything. Every option always renders exactly one action
    // control, whether that control offers `vote`, `change`, or the backed state,
    // so that is what gets counted.
    const optionActionButtons = before.optionActionCount;
    const voteButtons = before.buttons.filter((b) => b.text.includes("投一票"));
    const enabledVoteButtons = voteButtons.filter((b) => !b.disabled);
    const changeButtons = before.buttons.filter((b) => b.text.includes("改投到这个选项"));

    console.log("assertions");
    check("the wallet connected", connected);
    check(
      'no button is stuck on "提交中…"',
      !before.hasSubmittingLabel,
      before.hasSubmittingLabel ? "a button rendered the submitting label" : "",
    );
    // One control per option, always. This is the assertion that stays meaningful
    // in every voter state; the vote-button count below is deliberately allowed to
    // be zero when the account has already voted.
    check(
      "every option rendered exactly one action control",
      optionActionButtons === before.cardCount && optionActionButtons > 0,
      `actionControls=${optionActionButtons} cards=${before.cardCount}`,
    );
    check(
      "an account that has not voted yet is offered a vote button on every option",
      hasVoted || voteButtons.length === before.cardCount,
      `hasVoted=${hasVoted} voteButtons=${voteButtons.length} cards=${before.cardCount}`,
    );
    check(
      "an account that has voted is offered 改投 on every other option and no vote button",
      !hasVoted || (voteButtons.length === 0 && changeButtons.length === before.cardCount - 1),
      `hasVoted=${hasVoted} voteButtons=${voteButtons.length} changeButtons=${changeButtons.length} cards=${before.cardCount}`,
    );
    check(
      "exactly one option is marked as the one this account backed, and none when it has no vote",
      before.myOptionButtons === (votedForOption === null ? 0 : 1),
      `myOptions=${before.myOptionButtons} chainVotedFor=${votedForOption}`,
    );
    check(
      "vote buttons are enabled exactly when the chain says the account may vote",
      chainSaysVotable
        ? enabledVoteButtons.length === voteButtons.length
        : enabledVoteButtons.length === 0,
      `chainSaysVotable=${chainSaysVotable} enabled=${enabledVoteButtons.length}/${voteButtons.length}`,
    );
    // Asserted before the row checks that depend on it, because the failure it
    // guards is silent: if the closing heading is renamed, `panelEnd` is -1, the
    // slice runs to the end of the page, and the 白名单 assertion below starts
    // reading text from the whole document — passing for a reason that has nothing
    // to do with the panel. This check fails loudly instead.
    check(
      "the 我的状态 panel was located and bounded, so the row reads come from it",
      before.panelFound && before.panelBounded,
      `panelFound=${before.panelFound} panelBounded=${before.panelBounded}`,
    );
    // The panel reports admission with one row or the other, never both, and the
    // rule is that each appears exactly where it carries information:
    //
    //   * a 白名单 row whenever the poll HAS a list — and it must report this
    //     reader's membership even when `canVote` is true, because an admitted
    //     reader on a whitelisted poll otherwise cannot tell it apart from an
    //     open one;
    //   * a 准入方式 row only when the poll is open, since an open poll has no
    //     list and the mode is the fact worth stating.
    //
    // Both directions have been wrong in this drill's lifetime, in opposite ways,
    // which is why the assertion pins the exact pairing rather than checking one
    // row in isolation.
    const admissionCorrect = openToAll
      ? before.whitelistRow === null && before.modeRow === "所有人可投"
      : before.modeRow === null && before.whitelistRow === (isWhitelisted ? "是" : "否");

    check(
      openToAll
        ? "an open poll names the mode and shows no 白名单 row"
        : "a whitelisted poll shows the 白名单 row and no 准入方式 row",
      admissionCorrect,
      `openToAll=${openToAll} mode=${JSON.stringify(before.modeRow)} ` +
        `whitelist=${JSON.stringify(before.whitelistRow)} chainIsWhitelisted=${isWhitelisted}`,
    );
    // The row that replaces it. On both modes the panel must state the admission
    // verdict the contract itself returns, which is what `canVote` is.
    check(
      "the 可投票 row matches the contract's own canVote",
      before.canVoteRow === (chainSaysCanVote ? "是" : "否"),
      `openToAll=${openToAll} row=${JSON.stringify(before.canVoteRow)} canVote=${chainSaysCanVote}`,
    );
    check(
      "a disabled account is told why",
      enabledVoteButtons.length > 0 || voteButtons.every((b) => b.title !== null),
      voteButtons.map((b) => b.title).join(" | "),
    );
    check(
      "the page reached the wallet",
      before.walletMethods.length > 0,
      before.walletMethods.join(", "),
    );

    // The refund path. The stake is the user's own money and `sweepUnclaimed()`
    // hands an unclaimed stake to the owner after the grace period, so a refund
    // button that is wrongly disabled costs the user real ETH — which is why
    // this is asserted in *both* directions, and why a disabled one must speak.
    const refundButton = before.buttons.find((b) => b.text.includes("取回押金"));
    const refundEnabled = refundButton !== undefined && !refundButton.disabled;
    check("the ballot rendered a refund button", refundButton !== undefined);
    check(
      "the refund button is enabled exactly when the chain says the stake is refundable",
      refundEnabled === chainSaysRefundable,
      `chainSaysRefundable=${chainSaysRefundable} (phase=${phase} stake=${stake}) enabled=${refundEnabled}`,
    );
    check(
      "a disabled refund button states why",
      refundEnabled || (before.refundReason !== null && before.refundReason.length > 0),
      refundEnabled
        ? "button is enabled, so there is nothing to explain"
        : `refundReason=${JSON.stringify(before.refundReason)}`,
    );
    check(
      "the 押金 row matches stakeOf",
      before.stakeRow === `${formatEth(stake)} ETH`,
      `row=${JSON.stringify(before.stakeRow)} stake=${stake}`,
    );
    // Every metadata outcome the card can render, spelled out. A blank cell or an
    // unrecognised phrase fails here: `MetadataResult` gained a member in this
    // round of work, and the guards it used to be rendered with failed silently.
    const knownMetadataLabel = (label: string): boolean =>
      label === "已解析" ||
      label === "CID 格式无效，无法解析" ||
      label === "读取中…" ||
      label === "读取元数据时发生了未预期的错误" ||
      /^\d+ 个网关均不可达，已降级显示编号$/.test(label) ||
      /^网关可访问（\d+\/\d+ 个已作答），但没有返回可用的候选人元数据$/.test(label);
    check(
      "every option card states its metadata outcome in words",
      before.ipfsLabels.length === before.cardCount && before.ipfsLabels.every(knownMetadataLabel),
      `cards=${before.cardCount} labels=${JSON.stringify(before.ipfsLabels)}`,
    );
    // The defect this ties down: a ballot was seeded with `bafyseededcandidate0`,
    // and every card said "CID 格式无效，无法解析" — truthfully. The fault was
    // upstream, in the seed data, and nothing connected the sentence to the string
    // it was about. Asserted in both directions, so neither a resolvable CID
    // reported as malformed nor a malformed one passed off as a network problem
    // can get through unnoticed.
    const calledMalformed = (label: string): boolean => label === "CID 格式无效，无法解析";
    check(
      "a CID is called malformed exactly when it is not a shape that can resolve",
      before.ipfsLabels.every(
        (label, i) => calledMalformed(label) === !isPlausibleCid(before.metadataCids[i] ?? ""),
      ),
      `cids=${JSON.stringify(before.metadataCids)} labels=${JSON.stringify(before.ipfsLabels)}`,
    );
    // Asserted in both directions, because the failure this ties down is exactly
    // the placeholder that was on chain: metadata that arrives but is not rendered
    // looks identical to metadata that never arrived, and only the name tells them
    // apart. An empty read is NOT "not numbered" — the first version of this check
    // passed on `["","",""]` while every card said 已解析, which is the same
    // empty-assertion defect it was written to catch. The numbered fallback is
    // recognised by shape rather than against the option's id, which this script
    // does not assume equals the card's position.
    //
    // The shape has to track `optionName` in `src/lib/ballot-labels.ts`: it falls
    // back to `选项 #<id>`. It read `候选人 #<id>` before this project became
    // multi-tenant, and that stale pattern made the check one-directional without
    // failing — no real name could ever match it, so a card that had silently
    // stopped rendering its name would still have been reported as fine. Anything
    // that matches neither a document name nor this fallback is a defect.
    const namedFromDocument = (name: string): boolean =>
      name.length > 0 && !/^选项 #\d+$/.test(name);
    check(
      "a card shows a name from its document exactly when it resolved one",
      before.ipfsLabels.every(
        (label, i) => namedFromDocument(before.cardNames[i] ?? "") === (label === "已解析"),
      ),
      `names=${JSON.stringify(before.cardNames)} labels=${JSON.stringify(before.ipfsLabels)}`,
    );
    // The card offers to ask again only where another attempt could differ. A
    // malformed CID is decided by `isPlausibleCid` before any request, so a retry
    // there would offer something that cannot change; `ok` is content addressed
    // and can never come back different either. ADR-0018.
    const deterministic = before.ipfsLabels.map(
      (label) => label === "已解析" || label === "CID 格式无效，无法解析",
    );
    check(
      "a metadata outcome that cannot change offers no retry",
      before.ipfsRetries.every((offered, i) => !deterministic[i] || !offered),
      `labels=${JSON.stringify(before.ipfsLabels)} retries=${JSON.stringify(before.ipfsRetries)}`,
    );
    check(
      "a retry is offered only for a failure the network caused",
      before.ipfsRetries.every(
        (offered, i) =>
          !offered ||
          /^\d+ 个网关均不可达/.test(before.ipfsLabels[i]!) ||
          /^网关可访问（\d+\/\d+ 个已作答）/.test(before.ipfsLabels[i]!),
      ),
      `retries=${JSON.stringify(before.ipfsRetries)} labels=${JSON.stringify(before.ipfsLabels)}`,
    );

    // ---------------------------------------------------------------------
    // 运行状态 panel (P2-7)
    //
    // `/api/health` computed `lagBlocks`, `indexError`, `indexConfigured` and
    // `indexerLoopEnabled` and no interface rendered any of them, so a
    // deployment whose index was down looked exactly like a healthy one. These
    // assertions are what stops that regressing: the panel must exist, must be
    // opened by a real click, and must render a non-empty set of rows.
    //
    // It is collapsed by default, so a check that only read the page as loaded
    // would pass on a panel that renders nothing at all. That is why the click
    // is part of the assertion rather than setup.
    // ---------------------------------------------------------------------
    console.log("\nhealth panel");
    check("the 运行状态 panel is on the page", before.healthToggleFound);
    check(
      "the 运行状态 panel is collapsed before it is opened",
      !before.healthRowsFound,
      `rowsFound=${before.healthRowsFound}`,
    );

    const toggled = await browser.evaluate<string>(
      sessionId,
      `(() => {
        const b = document.querySelector('[data-testid="health-toggle"]');
        if (!b) return 'no-toggle';
        b.click();
        return 'clicked';
      })()`,
    );
    check("the 运行状态 toggle could be clicked", toggled === "clicked", toggled);

    // The rows arrive from a fetch that only starts once the panel is open, so
    // this waits for the row container rather than reading immediately.
    let health: PageState | undefined;
    const healthDeadline = Date.now() + 30_000;
    while (Date.now() < healthDeadline) {
      health = await browser.evaluate<PageState>(sessionId, READ_PAGE);
      if (health.healthRowsFound) break;
      await sleep(500);
    }

    check(
      "opening the panel renders its rows",
      health?.healthRowsFound === true,
      `rowsFound=${health?.healthRowsFound} count=${health?.healthRowCount}`,
    );
    // A container with zero rows would satisfy "found" while showing nothing.
    // Ten is the number `healthRows()` produces for a healthy response; the
    // exact figure is asserted in `web/test/health-report.test.ts` against the
    // pure function, so this only has to prove the panel is not empty.
    check(
      "the panel rendered every health row rather than an empty container",
      (health?.healthRowCount ?? 0) >= 10,
      `count=${health?.healthRowCount}`,
    );

    // ---------------------------------------------------------------------
    // 活动记录 panel and 导出结果 controls
    //
    // These are the "check the result without trusting the page" features, and
    // they are easy to get wrong in ways that compile and look fine: a panel
    // that renders an empty list because the index 404 was folded into "no
    // events", or an export link pointing at a route that does not exist.
    //
    // So the panel is opened by a real click and its rendered row count is
    // compared against the total it states — a truncated list would otherwise
    // pass a "more than zero" check.
    // ---------------------------------------------------------------------
    console.log("\nactivity panel and export");
    check("the 活动记录 panel is on the page", before.activityToggleFound);
    check(
      "the 活动记录 panel is collapsed before it is opened",
      !before.activityPanelFound,
      `panelFound=${before.activityPanelFound}`,
    );

    const openedActivity = await browser.evaluate<string>(
      sessionId,
      `(() => {
        const b = document.querySelector('[data-testid="activity-toggle"]');
        if (!b) return 'no-toggle';
        b.click();
        return 'clicked';
      })()`,
    );
    check("the 活动记录 toggle could be clicked", openedActivity === "clicked", openedActivity);

    // The list arrives from a fetch that starts only once the panel is open.
    //
    // The break condition waits for the query to SETTLE, which is not the same as
    // waiting for rows: while the request is in flight the panel shows a skeleton,
    // so `rows === 0`. An earlier version broke out as soon as the container
    // existed and `stated` was null, which is exactly the in-flight state — it
    // therefore read the panel mid-load and reported "renders nothing" for a feed
    // that was about to render 409 rows.
    let activity: PageState | undefined;
    const activityDeadline = Date.now() + 30_000;
    while (Date.now() < activityDeadline) {
      activity = await browser.evaluate<PageState>(sessionId, READ_PAGE);
      const settled =
        activity.activityRowCount > 0 ||
        activity.activityEmptyFound ||
        activity.activityUnavailableFound ||
        activity.activityErrorFound;
      if (activity.activityPanelFound && settled) {
        break;
      }
      await sleep(500);
    }

    check("opening the panel renders its container", activity?.activityPanelFound === true);

    /*
      The local chain has an index and both seeded polls have history, so the
      feed must be non-empty here. An empty render would mean the 404-for-no-index
      path and the empty-feed path had been collapsed into one — the exact
      confusion this panel's three states exist to prevent.
    */
    check(
      "the feed lists the poll's events rather than rendering nothing",
      (activity?.activityRowCount ?? 0) > 0,
      `rows=${activity?.activityRowCount} stated=${activity?.activityStated}`,
    );
    check(
      "the rendered row count matches the total the panel states",
      activity?.activityStated !== null &&
        activity?.activityStated !== undefined &&
        activity.activityRowCount === activity.activityStated,
      `rows=${activity?.activityRowCount} stated=${activity?.activityStated}`,
    );

    // The export links must point at this poll's own route. A link copied from
    // another page would still render and still be titled 下载 CSV.
    check(
      "the CSV export links to this poll's own route",
      activity?.exportCsvHref === `/api/polls/${pollAddress}/export?format=csv`,
      `href=${activity?.exportCsvHref}`,
    );
    check(
      "the JSON export links to this poll's own route",
      activity?.exportJsonHref === `/api/polls/${pollAddress}/export?format=json`,
      `href=${activity?.exportJsonHref}`,
    );

    /*
      And the export must actually answer. Fetching it in the page proves the
      route resolves end to end — the panel could render a correct href to a
      route that 503s, which no amount of DOM inspection would catch.

      The whole body is returned rather than a prefix: the tally header sits
      below the five metadata rows, so a short slice reports "no header" for a
      perfectly good file. Only the assertions decide what matters in it.
    */
    const exportProbe = await browser.evaluate<string>(
      sessionId,
      `fetch('/api/polls/${pollAddress}/export?format=csv')
         .then(async (r) => r.status + '|' + (await r.text()))
         .catch((e) => 'ERR|' + e.message)`,
    );
    check(
      "the CSV export route answers with a CSV document",
      exportProbe.startsWith("200|"),
      exportProbe.slice(0, 80),
    );
    check(
      "the exported CSV carries the tally header",
      exportProbe.includes("选项 ID"),
      `length=${exportProbe.length}`,
    );
    /*
      Line count is compared against the option rows the summary reports, not a
      hardcoded figure: this drill runs against whichever poll it was pointed at,
      and the two polls have different option counts. A CRLF count of at least
      7 proves the document carries the metadata block, the blank line, the
      header and at least one option row — i.e. it is a table, not a header.
    */
    const crlfCount = (exportProbe.match(/\r\n/g) ?? []).length;
    check(
      "the exported CSV is a real table rather than just a header",
      crlfCount >= 7,
      `crlf=${crlfCount} length=${exportProbe.length}`,
    );

    // ---------------------------------------------------------------------
    // 规则指纹 panel
    //
    // The point of this panel is that a reader need not trust the page, so the
    // drill applies the same standard: it reads the two fingerprints from the
    // chain ITSELF and computes the verdict independently, then requires the page
    // to have reached the same one.
    //
    // Checking the page's sentence against the page's own attribute would prove
    // nothing — a component that rendered "unchanged" for everything would pass.
    // ---------------------------------------------------------------------
    console.log("\nrules fingerprint");
    const chainCommitted = await client.readContract({
      address: pollAddress,
      abi: pollAbi,
      functionName: "rulesHash",
    });
    const chainCurrent = await client.readContract({
      address: pollAddress,
      abi: pollAbi,
      functionName: "currentRulesHash",
    });
    const chainVerdict = chainCommitted === chainCurrent ? "unchanged" : "changed";

    console.log(`chain            committed=${chainCommitted}`);
    console.log(`chain            current  =${chainCurrent}`);
    console.log(`chain            verdict  =${chainVerdict}`);

    // The panel reads from the browser's chain, and the verdict only appears
    // after mount plus two batched reads, so this waits for it to settle.
    let rules: PageState | undefined;
    const rulesDeadline = Date.now() + 30_000;
    while (Date.now() < rulesDeadline) {
      rules = await browser.evaluate<PageState>(sessionId, READ_PAGE);
      if (rules.rulesVerdict !== null && rules.rulesVerdict !== "pending") break;
      await sleep(500);
    }

    check(
      "the rules panel reached a definite verdict",
      rules?.rulesVerdict === "unchanged" || rules?.rulesVerdict === "changed",
      `verdict=${rules?.rulesVerdict}`,
    );
    check(
      "the page's verdict matches the one computed from the chain",
      rules?.rulesVerdict === chainVerdict,
      `page=${rules?.rulesVerdict} chain=${chainVerdict}`,
    );
    check(
      "the page shows the creation-time commitment exactly as the chain reports it",
      rules?.rulesCommitted?.toLowerCase() === chainCommitted.toLowerCase(),
      `page=${rules?.rulesCommitted} chain=${chainCommitted}`,
    );
    check(
      "the page shows the recomputed fingerprint exactly as the chain reports it",
      rules?.rulesCurrent?.toLowerCase() === chainCurrent.toLowerCase(),
      `page=${rules?.rulesCurrent} chain=${chainCurrent}`,
    );

    /*
      The stake-risk panel is conditional — it renders nothing when nothing is
      staked, because a warning about a risk of zero is noise. This poll is seeded
      with stakes, so it must be present; if it ever silently stops rendering, the
      only place a voter could learn their deposit has a deadline would be gone.
    */
    check(
      "the stake-risk panel is shown on a poll that holds stake",
      rules?.stakeRiskFound === true,
      `found=${rules?.stakeRiskFound}`,
    );

    if (REJECT) {
      console.log("\nreject");
      // The reader clicked 拒绝 in their wallet. Everything up to and including
      // the gas estimate succeeded; only the signature was refused, which is the
      // exact sequence that rendered `User rejected the request.` before ADR-0022.
      if (!chainSaysVotable) {
        check(
          "--reject requested, but the chain does not let this account start a vote",
          false,
          `openToAll=${openToAll} canVote=${chainSaysCanVote} hasVoted=${hasVoted} phase=${phase}`,
        );
      } else {
        const clicked = await browser.evaluate<string>(
          sessionId,
          `(() => {
            const b = [...document.querySelectorAll('button')].find((x) => !x.disabled && x.textContent.includes('投一票'));
            if (!b) return 'none';
            b.click();
            return 'clicked';
          })()`,
        );
        check("an enabled vote button could be clicked", clicked === "clicked", clicked);

        let after: PageState | undefined;
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline && after?.writeError == null) {
          await sleep(1000);
          after = await browser.evaluate<PageState>(sessionId, READ_PAGE);
        }

        check(
          "the refusal produced an error line at all",
          after?.writeError != null,
          `writeError=${JSON.stringify(after?.writeError ?? null)}`,
        );
        check(
          "the refusal is rendered as an identified cause, not as an unknown one",
          after?.writeErrorKind === "classified",
          `kind=${JSON.stringify(after?.writeErrorKind ?? null)}`,
        );
        check(
          "the sentence names the wallet and says nothing was sent",
          after?.writeError === "你在钱包里拒绝了这笔交易，链上没有任何变化。",
          `text=${JSON.stringify(after?.writeError ?? null)}`,
        );
        check(
          "no English from the wallet or viem survives into the page",
          after?.writeError != null && !/[A-Za-z]/.test(after.writeError),
          `text=${JSON.stringify(after?.writeError ?? null)}`,
        );
        check(
          "the refusal came from the wallet, after the page asked it to sign",
          after?.walletMethods.includes("eth_sendTransaction:refused") === true,
          after?.walletMethods.join(", ") ?? "",
        );
        check(
          "a refused signature is not called 提交中…",
          after != null && !after.hasSubmittingLabel,
        );

        // The claim the sentence makes. Asserted against the chain rather than
        // taken on trust, and compared with what the chain said *before* the
        // click — the account may legitimately have voted earlier in its life, so
        // "no vote" is not the property; "no change" is.
        //
        // `voterState` is compared as a whole tuple rather than field by field:
        // the sentence claims nothing at all changed, and comparing the tuple
        // cannot accidentally omit a field that a future write path starts
        // touching. `stakeOf` is read separately as well because the tuple's stake
        // slot is the same value, and a mismatch between the two would itself be
        // worth knowing about.
        const [voterAfter, stakeAfter] = await Promise.all([
          client.readContract({
            address: pollAddress,
            abi: pollAbi,
            functionName: "voterState",
            args: [account],
          }),
          client.readContract({
            address: pollAddress,
            abi: pollAbi,
            functionName: "stakeOf",
            args: [account],
          }),
        ]);
        const votedAfter = voterAfter[1] !== 0n;
        check(
          "链上没有任何变化 was true: voterState and stakeOf are what they were before the click",
          votedAfter === hasVoted && stakeAfter === stake,
          `before hasVoted=${hasVoted} stakeOf=${stake} wei, after hasVoted=${votedAfter} stakeOf=${stakeAfter} wei`,
        );
      }
    }

    if (VOTE) {
      console.log("\nvote");
      if (!chainSaysVotable) {
        // Not a defect, and the message says so: this is the drill refusing to
        // pretend it tested something. `--vote` cannot be driven for an account the
        // contract would reject, and the interesting cases are all reachable from a
        // fresh account. Naming the reason saves the reader from re-deriving it
        // from `hasVoted` / `phase` themselves.
        check(
          "--vote requested, but the chain does not allow this account to vote — use a fresh account",
          false,
          `openToAll=${openToAll} canVote=${chainSaysCanVote} hasVoted=${hasVoted} phase=${phase}; ` +
            `a vote needs canVote=true, hasVoted=false, phase=${PHASE_VOTING}`,
        );
      } else {
        const clicked = await browser.evaluate<string>(
          sessionId,
          `(() => {
            const b = [...document.querySelectorAll('button')].find((x) => !x.disabled && x.textContent.includes('投一票'));
            if (!b) return 'none';
            b.click();
            return 'clicked';
          })()`,
        );
        check("clicking an enabled vote button was possible", clicked === "clicked", clicked);

        let confirmed = false;
        let lastState: PageState | undefined;
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline && !confirmed) {
          await sleep(2000);
          lastState = await browser.evaluate<PageState>(sessionId, READ_PAGE);
          confirmed = await browser.evaluate<boolean>(
            sessionId,
            `document.body.innerText.includes('已确认')`,
          );
        }
        // The page's own account of the failure, so a stuck write reports WHY
        // rather than only that it did not confirm. Without this the drill says
        // "no receipt" and leaves the reader to guess between a rejected send, a
        // revert, and a page that never got that far.
        check(
          "the transaction reached a confirmed receipt",
          confirmed,
          `writeError=${JSON.stringify(lastState?.writeError ?? null)} ` +
            `kind=${JSON.stringify(lastState?.writeErrorKind ?? null)}`,
        );

        const after = await browser.evaluate<PageState>(sessionId, READ_PAGE);
        // The label this used to look for ("你已投给该候选人") dates from the
        // single-poll ballot and no longer exists, which made this assertion
        // unsatisfiable rather than merely stale — it could never pass, so it was
        // never a check. It reads the `data-option-action` attribute now, which is
        // the component's own contract for what each button does and does not
        // change with wording. Exactly one option must report `withdraw`-eligible
        // state as mine: the one just voted for.
        check(
          "exactly one option is now marked as the one this account backed",
          after.myOptionButtons === 1,
          `options reporting the voted state: ${after.myOptionButtons} (labels: ${JSON.stringify(after.voteButtonTexts)})`,
        );
        check('no button is stuck on "提交中…" afterwards', !after.hasSubmittingLabel);
      }
    }

    if (CHANGE) {
      console.log("\nchange");
      // 改投 is the capability this project gained when it became multi-tenant,
      // and it is the one the contract implements as a *distinct* event
      // (ADR-0024). Clicking it is the only way to prove the whole path: the
      // button's enabled state, a real signed transaction, the index folding the
      // change into the derived tally, and the option that is no longer backed
      // losing its vote.
      if (votedForOption === null) {
        check(
          "--change requested, but this account has no vote to change — use --vote first",
          false,
          `voterState.currentOptionId=0; a change needs an existing vote`,
        );
      } else {
        // Click a 改投 button, and remember which option it belonged to so the
        // chain can be asked about that exact option afterwards.
        const target = await browser.evaluate<{ clicked: string; optionId: string | null }>(
          sessionId,
          `(() => {
            const b = [...document.querySelectorAll('button[data-option-action="change"]')].find(
              (x) => !x.disabled,
            );
            if (!b) return { clicked: 'none', optionId: null };
            const optionId = b.getAttribute('data-option-id');
            b.click();
            return { clicked: 'clicked', optionId };
          })()`,
        );
        check(
          "clicking an enabled 改投 button was possible",
          target.clicked === "clicked",
          `clicked=${target.clicked} optionId=${JSON.stringify(target.optionId)}`,
        );
        check(
          "the 改投 button names the option it would move the vote to",
          target.optionId !== null && target.optionId !== String(votedForOption),
          `targetOption=${JSON.stringify(target.optionId)} currentlyBacked=${votedForOption}`,
        );

        let confirmed = false;
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline && !confirmed) {
          await sleep(2000);
          confirmed = await browser.evaluate<boolean>(
            sessionId,
            `document.body.innerText.includes('已确认')`,
          );
        }
        check("the change reached a confirmed receipt", confirmed);

        // The chain is the judge, not the page. Read `voterState` back and require
        // that the vote moved to the option whose button was clicked — a UI that
        // silently kept the old option while reporting success would fail here.
        const moved = await client.readContract({
          address: pollAddress,
          abi: pollAbi,
          functionName: "voterState",
          args: [account],
        });
        const newOption = Number(moved[1]);
        check(
          "the chain moved the vote to the option whose button was clicked",
          newOption === Number(target.optionId),
          `was ${votedForOption}, clicked ${target.optionId}, chain now says ${newOption}`,
        );
        check(
          "the account still backs exactly one option after changing",
          newOption !== 0,
          `currentOptionId=${newOption}`,
        );
        // The stake is not taken twice by a change: it is a move, not a second
        // vote, and the contract must not charge for it beyond gas.
        check(
          "a change did not add a second stake",
          moved[2] === stake,
          `stake before=${stake} wei, after=${moved[2]} wei`,
        );

        const after = await browser.evaluate<PageState>(sessionId, READ_PAGE);
        check(
          "the page marks the new option as mine and offers 改投 on the old one",
          after.myOptionButtons === 1,
          `myOptions=${after.myOptionButtons} labels=${JSON.stringify(after.voteButtonTexts)}`,
        );
        check('no button is stuck on "提交中…" after a change', !after.hasSubmittingLabel);
      }
    }

    if (REFUND) {
      console.log("\nrefund");
      if (!chainSaysRefundable) {
        check(
          "--refund requested, but the chain does not allow this account to refund",
          false,
          `phase=${phase} (needs ${PHASE_ENDED}) stake=${stake} wei (needs > 0)`,
        );
      } else {
        const clicked = await browser.evaluate<string>(
          sessionId,
          `(() => {
            const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('取回押金'));
            if (!b) return 'none';
            if (b.disabled) return 'disabled';
            b.click();
            return 'clicked';
          })()`,
        );
        check("clicking the enabled refund button was possible", clicked === "clicked", clicked);

        let confirmed = false;
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline && !confirmed) {
          await sleep(2000);
          confirmed = await browser.evaluate<boolean>(
            sessionId,
            `document.body.innerText.includes('已确认')`,
          );
        }
        check("the refund reached a confirmed receipt", confirmed);

        // The strongest assertion available: read the stake back off the chain
        // rather than trusting the UI to report it.
        const stakeAfter = await client.readContract({
          address: pollAddress,
          abi: pollAbi,
          functionName: "stakeOf",
          args: [account],
        });
        check(
          "the chain shows the stake was returned",
          stakeAfter === 0n,
          `stakeOf=${stakeAfter} wei (was ${stake}, stake constant is ${STAKE_WEI})`,
        );

        const after = await browser.evaluate<PageState>(sessionId, READ_PAGE);
        const refundAfter = after.buttons.find((b) => b.text.includes("取回押金"));
        check(
          "the refund button disabled itself once the stake was gone",
          refundAfter !== undefined && refundAfter.disabled,
        );
        check(
          "the page now says there is nothing to refund",
          after.refundReason !== null && after.refundReason.includes("没有可取回的押金"),
          `refundReason=${JSON.stringify(after.refundReason)}`,
        );
        check(
          "the 押金 row fell back to 0 ETH",
          after.stakeRow === `${formatEth(0n)} ETH`,
          `row=${JSON.stringify(after.stakeRow)}`,
        );
      }
    }

    if (SHOT) {
      const shot = await browser.send("Page.captureScreenshot", { format: "png" }, sessionId);
      writeFileSync(SHOT, Buffer.from(shot.data as string, "base64"));
      console.log(`\nscreenshot: ${SHOT}`);
    }

    // Read this last, so it reflects everything the page asked the wallet for —
    // including `eth_sendTransaction` when `--vote` or `--refund` ran.
    const finalState = await browser.evaluate<PageState>(sessionId, READ_PAGE);
    console.log(`\nwallet methods requested: ${finalState.walletMethods.join(", ")}`);

    console.log(`\nbrowser console (${browserMessages.length} message(s)):`);
    for (const message of browserMessages) {
      console.log(`  [${message.kind}/${message.level}] ${message.text}`);
    }

    // The assertion this whole capture exists for. A hydration mismatch surfaces
    // here as an error the DOM assertions cannot see, because React recovers by
    // re-rendering on the client: the page still looks right and every check above
    // still passes. Informational levels are deliberately not failures — React
    // DevTools' suggestion and similar are noise, not defects.
    const noisy = browserMessages.filter(
      (message) =>
        message.kind === "exception" || message.level === "error" || message.level === "warning",
    );
    check(
      // Scoped to this configuration on purpose. The drill injects `window.ethereum`,
      // so wagmi never falls back to its HTTP transport. A page with no wallet does,
      // and polls the RPC URL: measured as two log entries every ~4s in headless
      // Chrome, which denies the local-network permission without prompting. The
      // assertion says what it actually verified. See ADR-0018.
      "with the injected wallet, the page raised no exception and logged nothing above info level",
      noisy.length === 0,
      noisy.length === 0
        ? `${browserMessages.length} message(s), none above info`
        : `${noisy.length}, first: [${noisy[0]!.kind}/${noisy[0]!.level}] ${noisy[0]!.text}`,
    );

    return failures;
  } finally {
    chrome?.kill();
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // A locked profile directory is not worth failing the drill over.
    }
  }
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  console.error(`\nUI drill failed: ${error instanceof Error ? error.message : String(error)}`);
  exitCode = 1;
}

console.log(
  exitCode === 0 ? "\nUI drill: all checks passed." : `\nUI drill: ${exitCode} failure(s).`,
);
process.exitCode = exitCode;
