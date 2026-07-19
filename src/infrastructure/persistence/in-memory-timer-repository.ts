// src/infrastructure/persistence/in-memory-timer-repository.ts
import {
  ScheduledTimer,
  TimerRepositoryPort,
  TimerType,
} from '../../application/ports/timer-repository.port';

/** Test/dev fake. Production adapter is Postgres-backed (Day 4). */
export class InMemoryTimerRepository implements TimerRepositoryPort {
  private readonly timers = new Map<string, ScheduledTimer>();

  async save(timer: ScheduledTimer): Promise<void> {
    this.timers.set(timer.timerId, { ...timer });
  }

  async findDue(asOf: Date): Promise<ScheduledTimer[]> {
    return Array.from(this.timers.values()).filter(
      (t) => t.firedAt === null && t.cancelledAt === null && t.fireAt <= asOf,
    );
  }

  async markFired(timerId: string, firedAt: Date): Promise<void> {
    const timer = this.timers.get(timerId);
    if (timer) timer.firedAt = firedAt;
  }

  async markCancelled(timerId: string, cancelledAt: Date): Promise<void> {
    const timer = this.timers.get(timerId);
    if (timer) timer.cancelledAt = cancelledAt;
  }

  async findByCustomerAndType(customerId: string, timerType: TimerType): Promise<ScheduledTimer[]> {
    return Array.from(this.timers.values()).filter(
      (t) => t.customerId === customerId && t.timerType === timerType,
    );
  }
}
