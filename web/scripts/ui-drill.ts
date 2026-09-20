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
 * account's `isWhitelisted`, `hasVoted` and the phase straight from the chain and
 * asserts the rendered buttons match, so it is correct whether the account can
 * vote or not. With `--vote` it will additionally click through a real vote and
 * wait for the receipt.
 *
 * Read-only: it never mutates the chain. Use `--vote` only against a chain where
 * casting a vote is acceptable, or under a snapshot.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createPublicClient, defineChain, http } from "viem";

import { loadServerConfig } from "../src/lib/config";
import { votingAbi } from "../src/lib/contracts";

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter((value): value is string => typeof value === "string" && value.length > 0);

const DEBUG_PORT = Number(process.env.CDP_PORT ?? 9333);
const APP_URL = process.env.APP_URL ?? "http://127.0.0.1:3100/";
const VOTE = process.argv.includes("--vote");
const SHOT = process.env.SHOT ?? "";

const config = loadServerConfig();

// Guards run before any child process or temp directory exists, so `process.exit`
// has no resource to race with here. Every exit after that uses `process.exitCode`
// and lets the `finally` block clean up.
if (config.chainId !== 31337) {
  console.error(
    `Refusing to run: this drill casts a vote when given --vote, so it is limited to the local ` +
      `Hardhat network (31337). CHAIN_ID is ${config.chainId}.`,
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

interface ButtonState {
  text: string;
  disabled: boolean;
  title: string | null;
}

interface PageState {
  buttons: ButtonState[];
  hasSubmittingLabel: boolean;
  whitelistRow: string | null;
  connected: boolean;
  hasProvider: boolean;
  connectError: string | null;
  walletMethods: string[];
}

/** The provider injected before any page script, so wagmi sees a wallet. */
function walletSource(rpcUrl: string, address: `0x${string}`, chainIdHex: string): string {
  return `
(() => {
  const RPC = ${JSON.stringify(rpcUrl)};
  const ACCOUNT = ${JSON.stringify(address)};
  const CHAIN_ID_HEX = ${JSON.stringify(chainIdHex)};
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
  // The whitelist row is read from the "我的状态" panel specifically. A bare
  // search for the label matches the privacy notice earlier on the page, which
  // says the real gate is "管理员维护的白名单".
  const panelStart = text.indexOf('我的状态');
  const panelEnd = text.indexOf('候选人（');
  const panel = panelStart < 0 ? '' : text.slice(panelStart, panelEnd < 0 ? undefined : panelEnd);
  const rowAfter = (label) => {
    const i = panel.indexOf(label);
    if (i < 0) return null;
    return panel.slice(i + label.length).split('\\n').map((s) => s.trim()).filter(Boolean)[0] ?? null;
  };
  return {
    buttons,
    hasSubmittingLabel: text.includes('提交中…'),
    whitelistRow: rowAfter('白名单'),
    connected: buttons.some((b) => b.text === '断开'),
    hasProvider: typeof window.ethereum !== 'undefined',
    connectError: document.querySelector('.text-rose-600')?.textContent?.trim() ?? null,
    walletMethods: [...new Set(window.__walletCalls ?? [])],
  };
})()`;

let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let socket: WebSocket | undefined;

function send(
  method: string,
  params: Record<string, unknown> = {},
  sessionId?: string,
): Promise<any> {
  const id = nextId++;
  const payload: Record<string, unknown> = { id, method, params };
  if (sessionId !== undefined) payload.sessionId = sessionId;
  socket!.send(JSON.stringify(payload));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate<T>(sessionId: string, expression: string): Promise<T> {
  const result = await send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(`page evaluation failed: ${result.exceptionDetails.exception?.description}`);
  }
  return result.result.value as T;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForCdp(): Promise<{ Browser: string; webSocketDebuggerUrl: string }> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (response.ok) return (await response.json()) as never;
    } catch {
      // Chrome is not listening yet.
    }
    await sleep(300);
  }
  throw new Error(`Chrome did not open a DevTools endpoint on port ${DEBUG_PORT}`);
}

async function connectToPage(source: string): Promise<string> {
  const version = await waitForCdp();
  socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket!.addEventListener("open", () => resolve(), { once: true });
    socket!.addEventListener("error", () => reject(new Error("CDP socket failed")), { once: true });
  });

  const loaded = new Set<string>();
  socket.addEventListener("message", (event: MessageEvent) => {
    const message = JSON.parse(String(event.data)) as any;
    if (message.id !== undefined && pending.has(message.id)) {
      const entry = pending.get(message.id)!;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
      return;
    }
    if (message.method === "Page.loadEventFired" && message.sessionId)
      loaded.add(message.sessionId);
  });

  const target = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = (await send("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  })) as { sessionId: string };

  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send(
    "Emulation.setDeviceMetricsOverride",
    {
      width: 1440,
      height: 1600,
      deviceScaleFactor: 1,
      mobile: false,
    },
    sessionId,
  );
  await send("Page.addScriptToEvaluateOnNewDocument", { source }, sessionId);
  await send("Page.navigate", { url: APP_URL }, sessionId);

  const deadline = Date.now() + 30_000;
  while (!loaded.has(sessionId) && Date.now() < deadline) await sleep(200);
  if (!loaded.has(sessionId)) throw new Error(`the app at ${APP_URL} never finished loading`);

  // React hydration plus wagmi's first reads.
  await sleep(5000);
  return sessionId;
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
    const sessionId = await connectToPage(walletSource(config.rpcUrl, account, chainIdHex));

    // What the chain says, read independently of the page.
    const [isWhitelisted, hasVoted, phase] = await Promise.all([
      client.readContract({
        address: config.votingAddress,
        abi: votingAbi,
        functionName: "isWhitelisted",
        args: [account],
      }),
      client.readContract({
        address: config.votingAddress,
        abi: votingAbi,
        functionName: "hasVoted",
        args: [account],
      }),
      client.readContract({
        address: config.votingAddress,
        abi: votingAbi,
        functionName: "phase",
      }),
    ]);

    const PHASE_VOTING = 1;
    const chainSaysVotable = isWhitelisted && !hasVoted && Number(phase) === PHASE_VOTING;

    console.log(`\naccount          ${account}`);
    console.log(
      `chain            isWhitelisted=${isWhitelisted}  hasVoted=${hasVoted}  phase=${phase}`,
    );
    console.log(`app              ${APP_URL}\n`);

    // Fail loudly if the injection did not take. A silently broken injected
    // script leaves the page wallet-less, and every assertion below would then
    // pass or fail for reasons that have nothing to do with the app.
    const providerPresent = await evaluate<boolean>(
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
    const connectClick = await evaluate<string>(
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
      connected = await evaluate<boolean>(
        sessionId,
        `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '断开')`,
      );
    }
    console.log(
      `\nconnect: ${connectClick} -> ${connected ? "connected" : "still disconnected"}\n`,
    );

    const before = await evaluate<PageState>(sessionId, READ_PAGE);
    console.log(
      `diagnostics: provider injected=${before.hasProvider}` +
        `  connectError=${JSON.stringify(before.connectError)}` +
        `  walletMethods=${JSON.stringify(before.walletMethods)}\n`,
    );
    const voteButtons = before.buttons.filter((b) => b.text.includes("投一票"));
    const enabledVoteButtons = voteButtons.filter((b) => !b.disabled);

    console.log("assertions");
    check("the wallet connected", connected);
    check(
      'no button is stuck on "提交中…"',
      !before.hasSubmittingLabel,
      before.hasSubmittingLabel ? "a button rendered the submitting label" : "",
    );
    check("the ballot rendered a vote button per candidate", voteButtons.length > 0);
    check(
      "vote buttons are enabled exactly when the chain says the account may vote",
      chainSaysVotable
        ? enabledVoteButtons.length === voteButtons.length
        : enabledVoteButtons.length === 0,
      `chainSaysVotable=${chainSaysVotable} enabled=${enabledVoteButtons.length}/${voteButtons.length}`,
    );
    check(
      "the 白名单 row matches isWhitelisted",
      before.whitelistRow === (isWhitelisted ? "是" : "否"),
      `row=${JSON.stringify(before.whitelistRow)}`,
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

    if (VOTE) {
      console.log("\nvote");
      if (!chainSaysVotable) {
        check("--vote requested, but the chain does not allow this account to vote", false);
      } else {
        const clicked = await evaluate<string>(
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
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline && !confirmed) {
          await sleep(2000);
          confirmed = await evaluate<boolean>(
            sessionId,
            `document.body.innerText.includes('已确认')`,
          );
        }
        check("the transaction reached a confirmed receipt", confirmed);

        const after = await evaluate<PageState>(sessionId, READ_PAGE);
        check(
          "the card switched to 你已投给该候选人",
          after.buttons.some((b) => b.text.includes("你已投给该候选人")),
        );
        check('no button is stuck on "提交中…" afterwards', !after.hasSubmittingLabel);
      }
    }

    if (SHOT) {
      const shot = await send("Page.captureScreenshot", { format: "png" }, sessionId);
      writeFileSync(SHOT, Buffer.from(shot.data as string, "base64"));
      console.log(`\nscreenshot: ${SHOT}`);
    }

    // Read this last, so it reflects everything the page asked the wallet for —
    // including `eth_sendTransaction` when `--vote` ran.
    const finalState = await evaluate<PageState>(sessionId, READ_PAGE);
    console.log(`\nwallet methods requested: ${finalState.walletMethods.join(", ")}`);
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
