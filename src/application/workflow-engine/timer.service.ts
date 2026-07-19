// src/application/workflow-engine/timer.service.ts
import { randomUUID } from 'crypto';
import { ScheduledTimer, TimerRepositoryPort, TimerType } from '../ports/timer-repository.port';

/** Fixed durations per the spec's timer requirements — not configurable per-call, since these are regulatory/architectural constants, not tunable business parameters. */
export const TIMER_DURATIONS_MS: Record<TimerType, number | null> = {
  [TimerType.DOCUMENT_UPLOAD_EXPIRY]: 48 * 60 * 60 * 1000, // 48h — VerificationEvent.TIMER_48H
  [TimerType.VENDOR_CALLBACK_TIMEOUT]: 72 * 60 * 60 * 1000, // 72h — VerificationEvent.TIMER_72H
  [TimerType.WORKFLOW_OVERALL_TIMEOUT]: null, // caller supplies duration — varies by tier (5min/30min/48h)
  [TimerType.RE_VERIFICATION_DUE]: null, // caller supplies duration — varies by risk tier (2yr/8yr/10yr)
  [TimerType.EDD_MANUAL_REVIEW_DEADLINE]: 30 * 24 * 60 * 60 * 1000, // 30-day SLA for EDD manual review (Section B4.4)
};

export interface FiredTimerHandler {
  (timer: ScheduledTimer): Promise<void>;
}

/**
 * Schedules and fires expiration timers backed by TimerRepositoryPort —
 * i.e. persisted to a database, not an in-process setTimeout, so a
 * scheduled expiry survives an application restart (Day 3 requirement:
 * "Timers must survive system restarts"). A caller (a cron job or
 * BullMQ repeatable job in the real deployment) invokes pollAndFireDue()
 * on an interval; this class contains zero scheduling-loop logic itself,
 * only "what's due" and "what happens when it fires."
 */
export class TimerService {
  constructor(private readonly repository: TimerRepositoryPort) {}

  /**
   * Schedules a timer of a fixed-duration type (DOCUMENT_UPLOAD_EXPIRY,
   * VENDOR_CALLBACK_TIMEOUT, EDD_MANUAL_REVIEW_DEADLINE). Duration is
   * looked up from TIMER_DURATIONS_MS — callers cannot override it for
   * these types, since the durations are spec-mandated constants.
   */
  async scheduleFixedTimer(params: {
    timerType: Exclude<
      TimerType,
      TimerType.WORKFLOW_OVERALL_TIMEOUT | TimerType.RE_VERIFICATION_DUE
    >;
    customerId: string;
    requestId?: string | null;
    payload?: Record<string, unknown>;
    now?: Date;
  }): Promise<ScheduledTimer> {
    const durationMs = TIMER_DURATIONS_MS[params.timerType];
    if (durationMs === null) {
      throw new Error(
        `TimerType ${params.timerType} has no fixed duration — use scheduleCustomDurationTimer instead`,
      );
    }
    return this.persistTimer(params.timerType, durationMs, params);
  }

  /**
   * Schedules WORKFLOW_OVERALL_TIMEOUT or RE_VERIFICATION_DUE, whose
   * durations are tier/risk-dependent and supplied by the caller (Day 3's
   * WorkflowEngine for tier completion targets; Day 5's risk engine for
   * re-verification cadence) rather than fixed constants.
   */
  async scheduleCustomDurationTimer(params: {
    timerType: TimerType.WORKFLOW_OVERALL_TIMEOUT | TimerType.RE_VERIFICATION_DUE;
    durationMs: number;
    customerId: string;
    requestId?: string | null;
    payload?: Record<string, unknown>;
    now?: Date;
  }): Promise<ScheduledTimer> {
    if (params.durationMs <= 0) {
      throw new Error(`Timer duration must be positive, got ${params.durationMs}ms`);
    }
    return this.persistTimer(params.timerType, params.durationMs, params);
  }

  async cancelTimer(timerId: string, now: Date = new Date()): Promise<void> {
    await this.repository.markCancelled(timerId, now);
  }

  /**
   * Cancels every unfired, uncancelled timer of a given type for a
   * customer — used when a state transition makes an in-flight timer moot
   * (e.g. doc.uploaded arriving cancels that customer's pending
   * DOCUMENT_UPLOAD_EXPIRY timer so it doesn't spuriously fire later).
   */
  async cancelAllForCustomer(
    customerId: string,
    timerType: TimerType,
    now: Date = new Date(),
  ): Promise<number> {
    const timers = await this.repository.findByCustomerAndType(customerId, timerType);
    const active = timers.filter((t) => t.firedAt === null && t.cancelledAt === null);
    for (const timer of active) {
      await this.repository.markCancelled(timer.timerId, now);
    }
    return active.length;
  }

  /**
   * Finds all due, unfired, uncancelled timers and invokes the handler for
   * each, marking each fired only after its handler resolves successfully —
   * a handler that throws leaves its timer un-fired so the next poll retries
   * it, rather than silently dropping an expiry event.
   */
  async pollAndFireDue(
    handler: FiredTimerHandler,
    now: Date = new Date(),
  ): Promise<ScheduledTimer[]> {
    const due = await this.repository.findDue(now);
    const fired: ScheduledTimer[] = [];
    for (const timer of due) {
      await handler(timer);
      await this.repository.markFired(timer.timerId, now);
      fired.push({ ...timer, firedAt: now });
    }
    return fired;
  }

  private async persistTimer(
    timerType: TimerType,
    durationMs: number,
    params: {
      customerId: string;
      requestId?: string | null;
      payload?: Record<string, unknown>;
      now?: Date;
    },
  ): Promise<ScheduledTimer> {
    const now = params.now ?? new Date();
    const timer: ScheduledTimer = {
      timerId: randomUUID(),
      customerId: params.customerId,
      requestId: params.requestId ?? null,
      timerType,
      fireAt: new Date(now.getTime() + durationMs),
      payload: params.payload ?? {},
      firedAt: null,
      cancelledAt: null,
      createdAt: now,
    };
    await this.repository.save(timer);
    return timer;
  }
}
