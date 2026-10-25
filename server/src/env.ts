import type { D1Database } from "@cloudflare/workers-types"

export interface Env {
  readonly DB?: D1Database
  readonly API_BEARER_TOKEN?: string
  /** Additional, distinct secret required only for manual refresh. */
  readonly API_REFRESH_TOKEN?: string
  readonly REFRESH_ENABLED?: string
  /** Explicit operator policy; no unverified upstream quota is assumed. */
  readonly REFRESH_MIN_INTERVAL_SECONDS?: string
  readonly DEYE_BASE_URL?: string
  readonly DEYE_APP_ID?: string
  readonly DEYE_APP_SECRET?: string
  readonly DEYE_PASSWORD_HASH?: string
  readonly DEYE_EMAIL?: string
  readonly DEYE_USERNAME?: string
  readonly DEYE_MOBILE?: string
  readonly DEYE_COUNTRY_CODE?: string
  readonly DEYE_COMPANY_ID?: string
  readonly DEYE_DEVICE_SN?: string
  readonly DEYE_DEVICE_TYPE?: string
  /** Internal station key; never returned by the public API. */
  readonly STATION_ID?: string
  readonly FRESHNESS_THRESHOLD_SECONDS?: string
}
