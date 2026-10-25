import assert from "node:assert/strict"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { unstable_readConfig, type Unstable_Config } from "wrangler"
import { defineConfig } from "vitest/config"
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin"

// Prevent machine-level environment variables from becoming test bindings.
process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV = "false"

// Prevent Wrangler from using dotenv files as a fallback for the test config.
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false"

function normalizeConfig(configPath: string): Unstable_Config {
  const config: Unstable_Config = unstable_readConfig({ config: configPath })

  return {
    ...config,
    configPath: "<config>",
    userConfigPath: "<config>",
    d1_databases: (config.d1_databases ?? []).map((database) => ({
      ...database,
      database_name: "<isolated-test-database>",
      migrations_dir: resolve(dirname(configPath), database.migrations_dir ?? ""),
    })),
  }
}

const productionConfigPath = fileURLToPath(new URL("./wrangler.jsonc", import.meta.url))
const testConfigPath = fileURLToPath(new URL("./test/wrangler.jsonc", import.meta.url))

assert.deepStrictEqual(
  normalizeConfig(testConfigPath),
  normalizeConfig(productionConfigPath),
  "The test Wrangler config must mirror the production worker and migrations",
)

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      // Wrangler resolves .dev.vars beside this config, not server/wrangler.jsonc.
      wrangler: { configPath: "./test/wrangler.jsonc" },
      miniflare: {
        bindings: { TEST_MIGRATIONS: await readD1Migrations("./migrations") },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
}))
