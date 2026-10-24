import { Layer } from "effect"
import type { Env } from "../env"
import { StorageService } from "../services/StorageService"
import { makeD1Storage } from "../storage/D1Live"

export function storageLayer(env: Env) {
  return Layer.succeed(StorageService, makeD1Storage(env.DB))
}
