/** Statuses that mean "this exit is blocked here" by default. */
export const DEFAULT_BLOCK_STATUSES: readonly number[] = [403, 429];

export class BlockedError extends Error {
  override name = 'BlockedError';
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface ResponseLike {
  status(): number;
  url?(): string;
}

/** True when the status is one of `statuses` (default 403 and 429). */
export function isBlocked(response: ResponseLike | null | undefined, statuses: readonly number[] = DEFAULT_BLOCK_STATUSES): boolean {
  return !!response && statuses.includes(response.status());
}

/**
 * Throw a {@link BlockedError} when the response is a block, so a session
 * runner retires the proxy and retries with another one.
 */
export function assertNotBlocked(response: ResponseLike | null | undefined, statuses: readonly number[] = DEFAULT_BLOCK_STATUSES): void {
  if (isBlocked(response, statuses)) {
    const where = response!.url ? ` on ${response!.url()}` : '';
    throw new BlockedError(`blocked with HTTP ${response!.status()}${where}`, response!.status());
  }
}
