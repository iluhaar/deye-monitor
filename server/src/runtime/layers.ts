import type { Env } from "../env"
import { d1StorageLayer } from "../storage/D1Live"

export function storageLayer(env: Env) {
  return d1StorageLayer(env.DB)
}
