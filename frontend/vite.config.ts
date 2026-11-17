import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    exclude: ["@xmtp/wasm-bindings", "@xmtp/browser-sdk"],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const has = (sub: string) => id.indexOf(sub) !== -1;
          if (has("@xmtp/")) return undefined;
          if (!has("node_modules")) return undefined;
          if (
            has("/react/") ||
            has("/react-dom/") ||
            has("react-router") ||
            has("/scheduler/")
          ) {
            return "vendor-react";
          }
          if (has("@tanstack/") || has("/zustand/")) {
            return "vendor-state";
          }
          if (
            has("/viem/") ||
            has("@noble/") ||
            has("@scure/") ||
            has("/ox/")
          ) {
            return "vendor-crypto";
          }
          if (has("lucide-react")) {
            return "vendor-icons";
          }
          return undefined;
        },
      },
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts: true,
    proxy: {
      "/api": "http://127.0.0.1:8000",
      "/ws": {
        target: "ws://127.0.0.1:8000",
        ws: true,
      },
      "/a2a": "http://127.0.0.1:8000",
      "/.well-known": "http://127.0.0.1:8000",
    },
  },
});
