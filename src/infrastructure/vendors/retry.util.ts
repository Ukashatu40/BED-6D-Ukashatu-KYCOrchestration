// src/infrastructure/vendors/retry.util.ts
export interface RetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  backoffMultiplier: number;
  maxDelayMs: number;
  jitterMaxMs: number;
}

/** Per the spec's Retry and Backoff Specification table (p.41). */
export const DIGILOCKER_DOCUMENT_FETCH_RETRY: RetryPolicy = {
  maxRetries: 3,
  initialDelayMs: 1000,
  backoffMultiplier: 2,
  maxDelayMs: 8000,
  jitterMaxMs: 1000,
};

/** Per Retry and Backoff Specification table — CKYC search/download. */
export const CKYC_SEARCH_DOWNLOAD_RETRY: RetryPolicy = {
  maxRetries: 2,
  initialDelayMs: 2000,
  backoffMultiplier: 2,
  maxDelayMs: 10000,
  jitterMaxMs: 2000,
};

/** Per Retry and Backoff Specification table — CKYC individual upload. */
export const CKYC_UPLOAD_RETRY: RetryPolicy = {
  maxRetries: 3,
  initialDelayMs: 5000,
  backoffMultiplier: 2,
  maxDelayMs: 30000,
  jitterMaxMs: 5000,
};

/** Per Retry and Backoff Specification table — Video KYC session create. */
export const VIDEO_KYC_SESSION_CREATE_RETRY: RetryPolicy = {
  maxRetries: 2,
  initialDelayMs: 1000,
  backoffMultiplier: 2,
  maxDelayMs: 5000,
  jitterMaxMs: 1000,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generic exponential-backoff-with-jitter retry wrapper. `isRetryable`
 * decides per-error whether a retry is warranted — VALIDATION_ERROR-class
 * failures should never be retried even if attempts remain.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
  isRetryable: (err: unknown) => boolean,
): Promise<T> {
  let attempt = 0;
  let delay = policy.initialDelayMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (attempt > policy.maxRetries || !isRetryable(err)) {
        throw err;
      }
      const jitter = Math.random() * policy.jitterMaxMs;
      const waitMs = Math.min(delay + jitter, policy.maxDelayMs + policy.jitterMaxMs);
      await sleep(waitMs);
      delay = Math.min(delay * policy.backoffMultiplier, policy.maxDelayMs);
    }
  }
}
