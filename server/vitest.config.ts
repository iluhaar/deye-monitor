import { defineConfig } from "vitest/config"
import { cloudflarePool } from "@cloudflare/vitest-plugin"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    pool: cloudflarePool({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  },
})
