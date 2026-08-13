export type IdempotencyStoredResponse = {
  status: number;
  body: string;
  contentType?: string;
};

export type IdempotencyReservation =
  | { state: "acquired" }
  | { state: "pending" }
  | { state: "conflict" }
  | { state: "completed"; response: IdempotencyStoredResponse };

export interface IdempotencyStore {
  reserve(
    scope: string,
    key: string,
    requestHash: string,
    ttlSeconds: number,
  ): Promise<IdempotencyReservation>;

  complete(
    scope: string,
    key: string,
    requestHash: string,
    response: IdempotencyStoredResponse,
    ttlSeconds: number,
  ): Promise<void>;

  release(scope: string, key: string, requestHash: string): Promise<void>;
}
