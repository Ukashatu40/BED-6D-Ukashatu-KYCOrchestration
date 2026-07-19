// src/application/ports/timer-repository.port.ts
export enum TimerType {
  DOCUMENT_UPLOAD_EXPIRY = 'DOCUMENT_UPLOAD_EXPIRY', // 48h — VerificationEvent.TIMER_48H
  VENDOR_CALLBACK_TIMEOUT = 'VENDOR_CALLBACK_TIMEOUT', // 72h — VerificationEvent.TIMER_72H
  WORKFLOW_OVERALL_TIMEOUT = 'WORKFLOW_OVERALL_TIMEOUT', // tier-specific completion target
  RE_VERIFICATION_DUE = 'RE_VERIFICATION_DUE', // annual/biennial/quarterly per tier
  EDD_MANUAL_REVIEW_DEADLINE = 'EDD_MANUAL_REVIEW_DEADLINE', // 30-day EDD SLA (Section B4.4)
}

export interface ScheduledTimer {
  timerId: string;
  customerId: string;
  requestId: string | null;
  timerType: TimerType;
  fireAt: Date;
  payload: Record<string, unknown>;
  firedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
}

/**
 * Persistence port for scheduled timers. The real implementation is a
 * Postgres table polled on an interval (Day 4+) — this port exists so
 * TimerService's scheduling/firing logic is fully unit-testable today
 * without a database, and so timers genuinely survive process restarts in
 * production (an in-memory setTimeout does not).
 */
export interface TimerRepositoryPort {
  save(timer: ScheduledTimer): Promise<void>;
  findDue(asOf: Date): Promise<ScheduledTimer[]>;
  markFired(timerId: string, firedAt: Date): Promise<void>;
  markCancelled(timerId: string, cancelledAt: Date): Promise<void>;
  findByCustomerAndType(customerId: string, timerType: TimerType): Promise<ScheduledTimer[]>;
}
