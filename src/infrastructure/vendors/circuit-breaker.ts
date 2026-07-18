// src/infrastructure/vendors/circuit-breaker.ts
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  vendorType: string;
  failureThresholdPercent: number; // e.g. 50 = opens at 50% failure rate
  rollingWindowMs: number; // e.g. 60_000 = evaluate over a 60s window
  minimumRequestsInWindow: number; // don't trip on 1 failure out of 1 request
  openStateTimeoutMs: number; // e.g. 30_000 before probing half-open
}

export interface CircuitTransitionEvent {
  vendorType: string;
  fromState: CircuitState;
  toState: CircuitState;
  reason: string;
  occurredAt: Date;
}

type CircuitTransitionListener = (event: CircuitTransitionEvent) => void;

interface RequestOutcome {
  timestamp: number;
  succeeded: boolean;
}

/**
 * Per-vendor circuit breaker (ADR-005). CLOSED -> OPEN when the rolling
 * failure rate exceeds threshold; OPEN -> HALF_OPEN after a timeout; a single
 * probe request in HALF_OPEN either closes it or reopens it.
 *
 * State transitions are exposed via getState()/onTransition() so the caller
 * (VendorAdapterFactory wrapper) can write the mandatory audit events
 * (VendorCircuitBreakerOpened / VendorCircuitBreakerClosed) without this
 * class knowing anything about the audit trail — keeps it a pure
 * infrastructure-resilience primitive.
 */
export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private outcomes: RequestOutcome[] = [];
  private openedAt: number | null = null;
  private halfOpenProbeInFlight = false;
  private readonly listeners: CircuitTransitionListener[] = [];

  constructor(private readonly config: CircuitBreakerConfig) {}

  getState(): CircuitState {
    this.maybeTransitionToHalfOpen();
    return this.state;
  }

  onTransition(listener: CircuitTransitionListener): void {
    this.listeners.push(listener);
  }

  /**
   * Wraps a vendor call. Throws immediately without calling `fn` if the
   * circuit is OPEN. In HALF_OPEN, only one probe is allowed through at a
   * time — concurrent callers are short-circuited to avoid hammering a
   * recovering vendor.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.getState();

    if (currentState === 'OPEN') {
      throw new Error(`Circuit breaker OPEN for vendor ${this.config.vendorType}`);
    }

    if (currentState === 'HALF_OPEN') {
      if (this.halfOpenProbeInFlight) {
        throw new Error(
          `Circuit breaker HALF_OPEN for vendor ${this.config.vendorType} — probe already in flight`,
        );
      }
      this.halfOpenProbeInFlight = true;
    }

    try {
      const result = await fn();
      this.recordOutcome(true);
      if (currentState === 'HALF_OPEN') {
        this.transitionTo('CLOSED', 'Half-open probe succeeded');
      }
      return result;
    } catch (err) {
      this.recordOutcome(false);
      if (currentState === 'HALF_OPEN') {
        this.transitionTo('OPEN', 'Half-open probe failed');
      } else {
        this.evaluateThreshold();
      }
      throw err;
    } finally {
      this.halfOpenProbeInFlight = false;
    }
  }

  private recordOutcome(succeeded: boolean): void {
    const now = Date.now();
    this.outcomes.push({ timestamp: now, succeeded });
    this.pruneOldOutcomes(now);
  }

  private pruneOldOutcomes(now: number): void {
    const cutoff = now - this.config.rollingWindowMs;
    this.outcomes = this.outcomes.filter((o) => o.timestamp >= cutoff);
  }

  private evaluateThreshold(): void {
    if (this.outcomes.length < this.config.minimumRequestsInWindow) {
      return;
    }
    const failures = this.outcomes.filter((o) => !o.succeeded).length;
    const failureRate = (failures / this.outcomes.length) * 100;
    if (failureRate >= this.config.failureThresholdPercent) {
      this.transitionTo(
        'OPEN',
        `Failure rate ${failureRate.toFixed(1)}% exceeded threshold ${this.config.failureThresholdPercent}%`,
      );
    }
  }

  private maybeTransitionToHalfOpen(): void {
    if (
      this.state === 'OPEN' &&
      this.openedAt !== null &&
      Date.now() - this.openedAt >= this.config.openStateTimeoutMs
    ) {
      this.transitionTo('HALF_OPEN', 'Open-state timeout elapsed — probing recovery');
    }
  }

  private transitionTo(newState: CircuitState, reason: string): void {
    const fromState = this.state;
    if (fromState === newState) return;

    this.state = newState;
    if (newState === 'OPEN') {
      this.openedAt = Date.now();
    }
    if (newState === 'CLOSED') {
      this.openedAt = null;
      this.outcomes = [];
    }

    const event: CircuitTransitionEvent = {
      vendorType: this.config.vendorType,
      fromState,
      toState: newState,
      reason,
      occurredAt: new Date(),
    };
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
