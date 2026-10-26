import type { D1Database, RateLimit } from "@cloudflare/workers-types"
import type { D1Migration } from "@cloudflare/vitest-plugin"

declare global {
  namespace Cloudflare {
    interface Env {
      API_AUTH_RATE_LIMITER: RateLimit
      API_READ_RATE_LIMITER: RateLimit
      DB: D1Database
      TEST_MIGRATIONS: D1Migration[]
    }
  }
}
