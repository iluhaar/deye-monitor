import { Effect, Layer } from "effect"
import { normalizeDeyeDeviceLatest } from "../domain/normalization"
import { DeyeSchemaError } from "../errors/DeyeErrors"
import { DeyeService } from "../services/DeyeService"
import type { DeyeServiceShape } from "../services/DeyeService"
import { DeyeRawService } from "./DeyeRawService"
import type { DeyeRawServiceShape } from "./DeyeRawService"

/** Request-scoped raw adapter is already configured with the upstream device.
 * Internal station IDs must never be passed as device serials to Deye. */
export function makeNormalizedDeyeService(raw: DeyeRawServiceShape): DeyeServiceShape {
  return {
    readLatest: (stationId) => raw.readLatest("").pipe(Effect.flatMap((payload) =>
      Effect.try({
        try: () => normalizeDeyeDeviceLatest(payload, { stationId }),
        catch: () => new DeyeSchemaError({ operation: "device_latest", reason: "invalid_payload" }),
      }),
    )),
  }
}

export const normalizedDeyeLayer = Layer.effect(DeyeService, Effect.gen(function* () {
  return makeNormalizedDeyeService(yield* DeyeRawService)
}))
