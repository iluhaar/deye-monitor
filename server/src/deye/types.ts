/** A flexible measurement as returned by `/v1.0/device/latest`. */
export interface DeyeMeasurement {
  readonly key: string
  /** Values remain strings; missing upstream values remain null. */
  readonly value: string | null
  readonly unit: string | null
}

/** One device entry from the latest-data response. */
export interface DeyeDeviceLatest {
  readonly deviceSn: string
  readonly deviceType: string | null
  readonly deviceState: number | null
  /** Unix timestamp in seconds supplied by Deye, not a server timestamp. */
  readonly collectionTime: number | null
  readonly dataList: readonly DeyeMeasurement[]
}

/** Input for the read-only latest-data operation. */
export interface DeyeLatestRequest {
  /** Upstream device serial, not the server's internal station key. */
  readonly deviceSn: string
  readonly deviceType?: string
}

/**
 * Sanitized adapter result. The response message/code are safe envelope
 * metadata; access and refresh tokens are intentionally not returned.
 */
export interface DeyeLatest {
  readonly success: true
  readonly code: string | null
  readonly msg: string | null
  readonly deviceDataList: readonly DeyeDeviceLatest[]
  /** UTC time at which the adapter received the upstream response. */
  readonly fetchedAt: string
}
