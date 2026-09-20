import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // `mysql2` is a native-ish Node package that must not be bundled into the
  // server build; it is only ever imported from server-only modules.
  serverExternalPackages: ["mysql2"],
};

export default nextConfig;
