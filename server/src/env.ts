import type { D1Database } from "@cloudflare/workers-types"

export interface Env {
  readonly DB?: D1Database
  readonly API_BEARER_TOKEN?: string
  /** Internal station key; never returned by the public API. */
  readonly STATION_ID?: string
  readonly FRESHNESS_THRESHOLD_SECONDS?: string
}
