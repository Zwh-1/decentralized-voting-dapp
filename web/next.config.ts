import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // `mysql2` is a native-ish Node package that must not be bundled into the
  // server build; it is only ever imported from server-only modules.
  serverExternalPackages: ["mysql2"],

  // Emit a self-contained server bundle under `.next/standalone` so the
  // container image can ship that directory instead of all of `node_modules`
  // (~1 GB). Purely a packaging concern: it changes what is produced, not what
  // the app does. The container design that depends on this is in
  // docs/aegis/specs/2026-09-22-containerization-cicd-and-observability-design.md §6.1;
  // the ADR recording the decision is deferred to that plan's batch five.
  output: "standalone",
};

export default nextConfig;
