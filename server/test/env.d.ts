import type { D1Database } from "@cloudflare/workers-types"
import type { D1Migration } from "@cloudflare/vitest-plugin"

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database
      TEST_MIGRATIONS: D1Migration[]
    }
  }
}
