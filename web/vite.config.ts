import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The indexer API is proxied rather than called cross-origin, so the dev server
// has no CORS surface and the same code works when both are served from one
// origin in production.
const apiTarget = process.env.VITE_API_URL ?? "http://127.0.0.1:3001";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Vite 8 binds `localhost` to IPv6 `::1` only, which means
    // http://127.0.0.1:5173 is refused. Pinning the IPv4 loopback explicitly
    // makes the address predictable instead of depending on how the host
    // resolves `localhost`.
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
});
