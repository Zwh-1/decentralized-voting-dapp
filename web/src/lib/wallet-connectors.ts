// SPDX-License-Identifier: MIT
/**
 * Which wallet connectors the browser is offered, and why some are absent.
 *
 * ---------------------------------------------------------------------------
 * Why `injected()` is not enough on a phone
 * ---------------------------------------------------------------------------
 *
 * `injected()` reaches a wallet only when the wallet has injected itself into the
 * page. That is true in a desktop extension and in a mobile wallet's OWN in-app
 * browser, and false in Safari or Chrome on the same phone — where a reader
 * tapping "Connect" sees nothing happen, because there is no injected provider to
 * talk to. WalletConnect is the bridge for that case: the phone shows a QR code
 * (or opens the wallet app) and connects over a relay instead of through the page.
 *
 * ---------------------------------------------------------------------------
 * Why WalletConnect is OMITTED rather than broken when unconfigured
 * ---------------------------------------------------------------------------
 *
 * WalletConnect needs a `projectId` from Reown. Without one, adding the connector
 * anyway would produce a button that fails only for the readers who need it most,
 * with an error that names a project id they have never heard of. So when no
 * projectId is configured the connector is left out entirely and the reason is
 * reported once — the reader keeps the connectors that do work, and an operator
 * finds out why mobile browsers cannot connect.
 *
 * The projectId is a PUBLIC value by design (it ships in the client bundle), but
 * it is still read from the environment rather than committed: it is per-deployment
 * configuration and belongs with the other deployment settings.
 *
 * ---------------------------------------------------------------------------
 * Why the decision is a pure function
 * ---------------------------------------------------------------------------
 *
 * `resolveWalletConnect` takes the environment value and returns either a usable
 * id or a named reason. That is what makes "we refused this projectId and here is
 * why" testable without a browser, a wallet or a network — the same reason the
 * ballot's rule sentences were extracted from their component.
 */

/** A WalletConnect project id as Reown issues them: 32 hex characters. */
const PROJECT_ID_PATTERN = /^[0-9a-f]{32}$/i;

/** Why WalletConnect is not available, or that it is. */
export type WalletConnectStatus =
  | { available: true; projectId: string }
  | { available: false; reason: "not-configured" | "malformed" };

/**
 * Decides whether a usable WalletConnect project id was configured.
 *
 * The SHAPE is checked, not just presence. A placeholder left in a `.env`
 * (`NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=changeme`) would otherwise register a
 * connector that fails at the relay handshake — long after the deploy, only on
 * mobile, and with an error that does not mention configuration. Refusing it here
 * turns that into a one-line warning at startup.
 *
 * A malformed value is treated as absent rather than as fatal: the rest of the app
 * works without WalletConnect, and taking the whole page down over an optional
 * connector would be a worse trade than losing the connector.
 */
export function resolveWalletConnect(raw: string | undefined | null): WalletConnectStatus {
  const value = (raw ?? "").trim();

  if (value === "") {
    return { available: false, reason: "not-configured" };
  }

  if (!PROJECT_ID_PATTERN.test(value)) {
    return { available: false, reason: "malformed" };
  }

  return { available: true, projectId: value };
}

/**
 * What to tell the operator, or `null` when there is nothing to say.
 *
 * Deliberately never repeats the offending value. A malformed project id is still
 * a credential-shaped string, and ADR-0016's rule — give the shape, never the
 * value — applies to it exactly as it does to an RPC endpoint.
 */
export function walletConnectNotice(status: WalletConnectStatus): string | null {
  if (status.available) {
    return null;
  }

  if (status.reason === "not-configured") {
    return (
      "[wallet] NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is not set, so WalletConnect is not offered. " +
      "Wallets injected into the page still connect; mobile browsers outside a wallet's own browser will not. " +
      "Set the variable and rebuild to enable it."
    );
  }

  return (
    "[wallet] NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is not a valid project id (expected 32 hex characters), " +
    "so WalletConnect is not offered. Wallets injected into the page still connect. " +
    "The configured value is not shown here on purpose; check web/.env."
  );
}

/**
 * The name each wallet shows when it asks the reader to approve the connection.
 *
 * A constant because it is the app's identity in someone else's UI, and a second
 * spelling of it in a second connector is the kind of drift that shows up as two
 * different app names depending on which wallet you use.
 */
export const WALLET_APP_NAME = "Decentralized Voting Demo";
