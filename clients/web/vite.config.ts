import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const serverUrl = env.VITE_SERVER_URL?.trim() || "http://localhost:8787";
  if (mode === "production" && [
    env.VITE_SERVER_URL, env.VITE_API_BEARER_TOKEN, env.VITE_REFRESH_TOKEN,
  ].some((value) => value?.trim())) {
    throw new Error("Production uses the same-origin Worker proxy. Remove VITE_SERVER_URL and VITE_* tokens before building.");
  }

  return {
    plugins: [react()],
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
