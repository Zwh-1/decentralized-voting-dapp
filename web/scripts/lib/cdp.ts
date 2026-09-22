// SPDX-License-Identifier: MIT
/**
 * The Chrome DevTools Protocol driver the browser drills share.
 *
 * ---------------------------------------------------------------------------
 * Why this is a module
 * ---------------------------------------------------------------------------
 *
 * `ui-drill.ts` grew to 1263 lines carrying three unrelated jobs: talking CDP,
 * describing a page, and asserting what the page said. Only the first is
 * reusable, and it is the one with the subtle parts — the id/response map, the
 * message router, the session handshake — so it is the piece that benefits from
 * being readable on its own.
 *
 * It is still a script rather than a tested module: driving a real browser cannot
 * be unit tested without the browser. What the split buys is that a change to the
 * assertions no longer risks the transport, and vice versa.
 *
 * ---------------------------------------------------------------------------
 * Why a raw CDP socket instead of Playwright
 * ---------------------------------------------------------------------------
 *
 * Deliberate, and worth stating because it looks like reinvention. This drill
 * exists to watch a REAL browser reconcile the server's HTML, and the failures it
 * was built to catch are exactly the ones a wrapper hides: a React hydration
 * mismatch, an uncaught exception inside an event handler, a 404 the browser logs
 * and the framework swallows. Those arrive as `Runtime.exceptionThrown` and
 * `Log.entryAdded` events, which a wrapper's convenience API does not surface —
 * and installing Playwright would also download a second browser to run what this
 * repo already has.
 */

/** Where Chrome's DevTools endpoint listens. */
export const DEBUG_PORT = Number(process.env.CDP_PORT ?? 9333);

/** What the page said while the drill was driving it. */
export interface BrowserMessage {
  kind: "console" | "exception" | "log";
  level: string;
  text: string;
}

/** Trims a value to something a failure message can print. */
export function shorten(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .slice(0, 400);
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A connected CDP session over one browser.
 *
 * Every method here is thin on purpose: `evaluate` and `waitFor` are the only
 * two the drills actually need, and neither tries to interpret what the page did.
 * The interpretation belongs in the drill, where the assertion lives.
 */
export class CdpBrowser {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  private socket: WebSocket | undefined;

  /** Everything the page logged, threw, or had refused by the browser. */
  readonly messages: BrowserMessage[] = [];

  private readonly loaded = new Set<string>();

  constructor(private readonly port: number = DEBUG_PORT) {}

  /** Sends one CDP command and resolves with its result. */
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };

    if (sessionId !== undefined) {
      payload.sessionId = sessionId;
    }

    this.socket!.send(JSON.stringify(payload));

    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  /**
   * Runs an expression in the page and returns its value.
   *
   * `awaitPromise` is what lets the callers write an `async` expression and have
   * it behave; without it every caller would have to poll.
   */
  async evaluate<T>(sessionId: string, expression: string): Promise<T> {
    const result = await this.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );

    if (result.exceptionDetails) {
      throw new Error(`page evaluation failed: ${result.exceptionDetails.exception?.description}`);
    }

    return result.result.value as T;
  }

  /** Waits until Chrome is listening, then opens the socket. */
  private async connect(): Promise<{ webSocketDebuggerUrl: string }> {
    const deadline = Date.now() + 30_000;

    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/json/version`);

        if (response.ok) {
          return (await response.json()) as { webSocketDebuggerUrl: string };
        }
      } catch {
        // Chrome is not listening yet.
      }

      await sleep(300);
    }

    throw new Error(`Chrome did not open a DevTools endpoint on port ${this.port}`);
  }

  /**
   * Opens a page, injects `source` before any page script, and navigates.
   *
   * The injection point is the whole reason this exists: the fake wallet has to
   * define `window.ethereum` before wagmi's first read, and injecting after load
   * would be racing the very code the drill is testing.
   */
  async openPage(options: { source: string; url: string; width?: number; height?: number }) {
    const version = await this.connect();
    this.socket = new WebSocket(version.webSocketDebuggerUrl);

    await new Promise<void>((resolve, reject) => {
      this.socket!.addEventListener("open", () => resolve(), { once: true });
      this.socket!.addEventListener("error", () => reject(new Error("CDP socket failed")), {
        once: true,
      });
    });

    this.listen();

    const target = await this.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = (await this.send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    })) as { sessionId: string };

    await this.send("Page.enable", {}, sessionId);
    await this.send("Runtime.enable", {}, sessionId);
    await this.send("Log.enable", {}, sessionId);
    await this.send(
      "Emulation.setDeviceMetricsOverride",
      {
        width: options.width ?? 1440,
        height: options.height ?? 1600,
        deviceScaleFactor: 1,
        mobile: false,
      },
      sessionId,
    );
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source: options.source }, sessionId);
    await this.send("Page.navigate", { url: options.url }, sessionId);

    const deadline = Date.now() + 30_000;

    while (!this.loaded.has(sessionId) && Date.now() < deadline) {
      await sleep(200);
    }

    if (!this.loaded.has(sessionId)) {
      throw new Error(`the app at ${options.url} never finished loading`);
    }

    // React hydration plus wagmi's first reads.
    await sleep(5000);

    return sessionId;
  }

  /** Routes inbound CDP messages: command replies, load events, and page noise. */
  private listen(): void {
    this.socket!.addEventListener("message", (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as any;

      if (message.id !== undefined && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id)!;
        this.pending.delete(message.id);

        if (message.error) {
          entry.reject(new Error(JSON.stringify(message.error)));
        } else {
          entry.resolve(message.result);
        }

        return;
      }

      if (message.method === "Page.loadEventFired" && message.sessionId) {
        this.loaded.add(message.sessionId);
      }

      if (message.method === "Runtime.consoleAPICalled") {
        const text = (message.params.args ?? [])
          .map((argument: any) => argument.value ?? argument.description ?? argument.type)
          .join(" ");

        this.messages.push({ kind: "console", level: message.params.type, text: shorten(text) });
        return;
      }

      if (message.method === "Runtime.exceptionThrown") {
        const details = message.params.exceptionDetails ?? {};

        this.messages.push({
          kind: "exception",
          level: "error",
          text: shorten(details.exception?.description ?? details.text),
        });
        return;
      }

      // `Log` carries what never reaches `Runtime`: failed requests, CSP reports,
      // and anything the browser itself refuses. A 404 for a missing asset shows
      // up here and nowhere else.
      if (message.method === "Log.entryAdded") {
        const entry = message.params.entry ?? {};

        this.messages.push({
          kind: "log",
          level: entry.level,
          text: shorten(`${entry.source}: ${entry.text}${entry.url ? ` (${entry.url})` : ""}`),
        });
      }
    });
  }

  close(): void {
    this.socket?.close();
  }
}
