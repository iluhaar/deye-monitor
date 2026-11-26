import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, ".", "");
  const serverUrl = env.VITE_SERVER_URL?.trim() || "http://localhost:8787";
  return {
    plugins: [react()],
    // Local credentials are for the dev proxy only, never the browser build.
    envPrefix: command === "serve" ? "VITE_" : [],
    server: {
      proxy: {
        // More specific than /api. YASNO does not send CORS headers, so dev
        // uses the same same-origin path the Worker proxies in production.
        "/api/v1/outage-schedule": {
          target: "https://app.yasno.ua",
          changeOrigin: true,
          rewrite: () =>
            "/api/blackout-service/public/shutdowns/regions/25/dsos/902/planned-outages",
        },
        "/api": {
          target: serverUrl,
          changeOrigin: true,
        },
      },
    },
  };
});
