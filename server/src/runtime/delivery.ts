import type { GridEventDelivery } from "../services/GridEventDelivery"
import type { GridEventStream } from "../subscriptions/GridEventStream"

export function gridEventDelivery(streams: DurableObjectNamespace<GridEventStream>): GridEventDelivery {
  return {
    arm: (stationId, eventId, leaseUntil) => streams.getByName(stationId).arm(stationId, eventId, leaseUntil),
    publish: (stationId) => streams.getByName(stationId).publish(),
  }
}
