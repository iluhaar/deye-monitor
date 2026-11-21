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
        "/api": {
          target: serverUrl,
          changeOrigin: true,
        },
      },
    },
  };
});
