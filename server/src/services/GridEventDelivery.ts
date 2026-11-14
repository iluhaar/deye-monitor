/** A durable reservation must be armed before a transition is allowed to commit. */
export interface GridEventDelivery {
  readonly arm: (stationId: string, eventId: string, leaseUntil: string) => Promise<void>
  readonly publish: (stationId: string) => Promise<void>
}
