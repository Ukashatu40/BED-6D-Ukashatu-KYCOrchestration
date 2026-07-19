// src/application/workflow-engine/timer.service.spec.ts
import { TimerService } from './timer.service';
import { InMemoryTimerRepository } from '../../infrastructure/persistence/in-memory-timer-repository';
import { TimerType } from '../ports/timer-repository.port';
import { describe, it, expect, jest } from '@jest/globals';

describe('TimerService', () => {
  describe('scheduleFixedTimer', () => {
    it('schedules a DOCUMENT_UPLOAD_EXPIRY timer exactly 48 hours out', async () => {
      const repo = new InMemoryTimerRepository();
      const service = new TimerService(repo);
      const now = new Date('2026-01-01T00:00:00.000Z');
      const timer = await service.scheduleFixedTimer({
        timerType: TimerType.DOCUMENT_UPLOAD_EXPIRY,
        customerId: 'cust-001',
        now,
      });
      expect(timer.fireAt.toISOString()).toBe('2026-01-03T00:00:00.000Z');
    });

    it('schedules a VENDOR_CALLBACK_TIMEOUT timer exactly 72 hours out', async () => {
      const repo = new InMemoryTimerRepository();
      const service = new TimerService(repo);
      const now = new Date('2026-01-01T00:00:00.000Z');
      const timer = await service.scheduleFixedTimer({
        timerType: TimerType.VENDOR_CALLBACK_TIMEOUT,
        customerId: 'cust-001',
        now,
      });
      expect(timer.fireAt.toISOString()).toBe('2026-01-04T00:00:00.000Z');
    });

    it('schedules an EDD_MANUAL_REVIEW_DEADLINE timer exactly 30 days out', async () => {
      const repo = new InMemoryTimerRepository();
      const service = new TimerService(repo);
      const now = new Date('2026-01-01T00:00:00.000Z');
      const timer = await service.scheduleFixedTimer({
        timerType: TimerType.EDD_MANUAL_REVIEW_DEADLINE,
        customerId: 'cust-001',
        now,
      });
      expect(timer.fireAt.toISOString()).toBe('2026-01-31T00:00:00.000Z');
    });

    it('rejects a fixed-duration call for a variable-duration timer type', async () => {
      const repo = new InMemoryTimerRepository();
      const service = new TimerService(repo);
      await expect(
        service.scheduleFixedTimer({
          // @ts-expect-error — intentionally testing runtime guard for a type the compiler would otherwise reject
          timerType: TimerType.WORKFLOW_OVERALL_TIMEOUT,
          customerId: 'cust-001',
        }),
      ).rejects.toThrow(/has no fixed duration/);
    });

    it('persists the timer to the repository', async () => {
      const repo = new InMemoryTimerRepository();
      const service = new TimerService(repo);
      const timer = await service.scheduleFixedTimer({
        timerType: TimerType.DOCUMENT_UPLOAD_EXPIRY,
        customerId: 'cust-001',
      });
      const found = await repo.findByCustomerAndType('cust-001', TimerType.DOCUMENT_UPLOAD_EXPIRY);
      expect(found).toHaveLength(1);
      expect(found[0].timerId).toBe(timer.timerId);
    });
  });

  describe('scheduleCustomDurationTimer', () => {
    it('schedules a WORKFLOW_OVERALL_TIMEOUT with a caller-supplied duration (MINIMUM tier: 5 min)', async () => {
      const repo = new InMemoryTimerRepository();
      const service = new TimerService(repo);
      const now = new Date('2026-01-01T00:00:00.000Z');
      const timer = await service.scheduleCustomDurationTimer({
        timerType: TimerType.WORKFLOW_OVERALL_TIMEOUT,
        durationMs: 5 * 60 * 1000,
        customerId: 'cust-001',
        now,
      });
      expect(timer.fireAt.toISOString()).toBe('2026-01-01T00:05:00.000Z');
    });

    it('schedules a RE_VERIFICATION_DUE timer for high-risk annual cadence', async () => {
      const repo = new InMemoryTimerRepository();
      const service = new TimerService(repo);
      const now = new Date('2026-01-01T00:00:00.000Z');
      const twoYearsMs = 2 * 365 * 24 * 60 * 60 * 1000;
      const timer = await service.scheduleCustomDurationTimer({
        timerType: TimerType.RE_VERIFICATION_DUE,
        durationMs: twoYearsMs,
        customerId: 'cust-001',
        now,
      });
      expect(timer.fireAt.getTime()).toBe(now.getTime() + twoYearsMs);
    });

    it('rejects a non-positive duration', async () => {
      const repo = new InMemoryTimerRepository();
      const service = new TimerService(repo);
      await expect(
        service.scheduleCustomDurationTimer({
          timerType: TimerType.WORKFLOW_OVERALL_TIMEOUT,
          durationMs: 0,
          customerId: 'cust-001',
        }),
      ).rejects.toThrow(/must be positive/);
    });
  });

  describe('cancelTimer', () => {
    it('marks a timer as cancelled so it no longer appears in findDue', async () => {
      const repo = new InMemoryTimerRepository();
      const service = new TimerService(repo);
      const now = new Date('2026-01-01T00:00:00.000Z');
      const timer = await service.scheduleFixedTimer({
        timerType: TimerType.DOCUMENT_UPLOAD_EXPIRY,
        customerId: 'cust-001',
        now,
      });
      await service.cancelTimer(timer.timerId, now);
      const due = await repo.findDue(new Date(now.getTime() + 49 * 60 * 60 * 1000));
      expect(due).toHaveLength(0);
    });
  });

  describe('cancelAllForCustomer', () => {
    it('cancels all active timers of a given type for a customer and returns the count', async () => {
      const repo = new InMemoryTimerRepository();
      const service = new TimerService(repo);
      await service.scheduleFixedTimer({
        timerType: TimerType.DOCUMENT_UPLOAD_EXPIRY,
        customerId: 'cust-001',
      });
      await service.scheduleFixedTimer({
        timerType: TimerType.DOCUMENT_UPLOAD_EXPIRY,
        customerId: 'cust-001',
      });
      const cancelledCount = await service.cancelAllForCustomer(
        'cust-001',
        TimerType.DOCUMENT_UPLOAD_EXPIRY,
      );
      expect(cancelledCount).toBe(2);
    });

    it('does not affect a different customer’s timers of the same type', async () => {
      const repo = new InMemoryTimerRepository();
      const service = new TimerService(repo);
      await service.scheduleFixedTimer({
        timerType: TimerType.DOCUMENT_UPLOAD_EXPIRY,
        customerId: 'cust-001',
      });
      await service.scheduleFixedTimer({
        timerType: TimerType.DOCUMENT_UPLOAD_EXPIRY,
        customerId: 'cust-002',
      });
      await service.cancelAllForCustomer('cust-001', TimerType.DOCUMENT_UPLOAD_EXPIRY);
      const cust2Timers = await repo.findByCustomerAndType(
        'cust-002',
        TimerType.DOCUMENT_UPLOAD_EXPIRY,
      );
      expect(cust2Timers[0].cancelledAt).toBeNull();
    });

    it('does not re-cancel an already-fired timer (returns 0 for that timer)', async () => {
      const repo = new InMemoryTimerRepository();
      const service = new TimerService(repo);
      const now = new Date('2026-01-01T00:00:00.000Z');
      const timer = await service.scheduleFixedTimer({
        timerType: TimerType.DOCUMENT_UPLOAD_EXPIRY,
        customerId: 'cust-001',
        now,
      });
      await repo.markFired(timer.timerId, new Date(now.getTime() + 49 * 60 * 60 * 1000));
      const cancelledCount = await service.cancelAllForCustomer(
        'cust-001',
        TimerType.DOCUMENT_UPLOAD_EXPIRY,
      );
      expect(cancelledCount).toBe(0);
    });
  });

  describe('pollAndFireDue', () => {
    it('fires a timer once it is due and invokes the handler', async () => {
      const repo = new InMemoryTimerRepository();
      const service = new TimerService(repo);
      const now = new Date('2026-01-01T00:00:00.000Z');
      await service.scheduleFixedTimer({
        timerType: TimerType.DOCUMENT_UPLOAD_EXPIRY,
        customerId: 'cust-001',
        now,
      });

      const handler = jest.fn(async () => {});
      const notYetDue = await service.pollAndFireDue(
        handler,
        new Date(now.getTime() + 1 * 60 * 60 * 1000),
      );
      expect(notYetDue).toHaveLength(0);
      expect(handler).not.toHaveBeenCalled();

      const due = await service.pollAndFireDue(
        handler,
        new Date(now.getTime() + 49 * 60 * 60 * 1000),
      );
      expect(due).toHaveLength(1);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('does not re-fire an already-fired timer on a subsequent poll', async () => {
      const repo = new InMemoryTimerRepository();
      const service = new TimerService(repo);
      const now = new Date('2026-01-01T00:00:00.000Z');
      await service.scheduleFixedTimer({
        timerType: TimerType.DOCUMENT_UPLOAD_EXPIRY,
        customerId: 'cust-001',
        now,
      });
      const laterTime = new Date(now.getTime() + 49 * 60 * 60 * 1000);

      const handler = jest.fn(async () => {});
      await service.pollAndFireDue(handler, laterTime);
      await service.pollAndFireDue(handler, laterTime);
      expect(handler).toHaveBeenCalledTimes(1); // second poll finds nothing new
    });

    it('does not fire a cancelled timer even if its fireAt has passed', async () => {
      const repo = new InMemoryTimerRepository();
      const service = new TimerService(repo);
      const now = new Date('2026-01-01T00:00:00.000Z');
      const timer = await service.scheduleFixedTimer({
        timerType: TimerType.DOCUMENT_UPLOAD_EXPIRY,
        customerId: 'cust-001',
        now,
      });
      await service.cancelTimer(timer.timerId, now);

      const handler = jest.fn(async () => {});
      const fired = await service.pollAndFireDue(
        handler,
        new Date(now.getTime() + 49 * 60 * 60 * 1000),
      );
      expect(fired).toHaveLength(0);
      expect(handler).not.toHaveBeenCalled();
    });

    it('leaves a timer un-fired for retry on the next poll if its handler throws', async () => {
      const repo = new InMemoryTimerRepository();
      const service = new TimerService(repo);
      const now = new Date('2026-01-01T00:00:00.000Z');
      await service.scheduleFixedTimer({
        timerType: TimerType.DOCUMENT_UPLOAD_EXPIRY,
        customerId: 'cust-001',
        now,
      });
      const laterTime = new Date(now.getTime() + 49 * 60 * 60 * 1000);

      const failingHandler = jest.fn(async () => {
        throw new Error('audit write failed');
      });
      await expect(service.pollAndFireDue(failingHandler, laterTime)).rejects.toThrow(
        'audit write failed',
      );

      // Timer should still be due on the next poll since markFired was never reached.
      const stillDue = await repo.findDue(laterTime);
      expect(stillDue).toHaveLength(1);
    });

    it('fires multiple due timers from a single poll call, each exactly once', async () => {
      const repo = new InMemoryTimerRepository();
      const service = new TimerService(repo);
      const now = new Date('2026-01-01T00:00:00.000Z');
      await service.scheduleFixedTimer({
        timerType: TimerType.DOCUMENT_UPLOAD_EXPIRY,
        customerId: 'cust-001',
        now,
      });
      await service.scheduleFixedTimer({
        timerType: TimerType.DOCUMENT_UPLOAD_EXPIRY,
        customerId: 'cust-002',
        now,
      });

      const handler = jest.fn(async () => {});
      const fired = await service.pollAndFireDue(
        handler,
        new Date(now.getTime() + 49 * 60 * 60 * 1000),
      );
      expect(fired).toHaveLength(2);
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('passes the full ScheduledTimer (including payload) to the handler', async () => {
      const repo = new InMemoryTimerRepository();
      const service = new TimerService(repo);
      const now = new Date('2026-01-01T00:00:00.000Z');
      await service.scheduleFixedTimer({
        timerType: TimerType.DOCUMENT_UPLOAD_EXPIRY,
        customerId: 'cust-001',
        requestId: 'req-001',
        payload: { tier: 'MINIMUM' },
        now,
      });

      const handler = jest.fn(async () => {});
      await service.pollAndFireDue(handler, new Date(now.getTime() + 49 * 60 * 60 * 1000));
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: 'cust-001',
          requestId: 'req-001',
          payload: { tier: 'MINIMUM' },
        }),
      );
    });
  });

  describe('restart survival (persistence contract)', () => {
    it('a timer scheduled by one TimerService instance is found due by a fresh instance sharing the same repository', async () => {
      // Models the restart scenario: process A schedules the timer, dies;
      // process B (new TimerService, same underlying Postgres table) polls
      // and correctly fires it. In-memory setTimeout could never satisfy this.
      const repo = new InMemoryTimerRepository();
      const serviceBeforeRestart = new TimerService(repo);
      const now = new Date('2026-01-01T00:00:00.000Z');
      await serviceBeforeRestart.scheduleFixedTimer({
        timerType: TimerType.DOCUMENT_UPLOAD_EXPIRY,
        customerId: 'cust-001',
        now,
      });

      const serviceAfterRestart = new TimerService(repo); // fresh instance, same repo
      const handler = jest.fn(async () => {});
      const fired = await serviceAfterRestart.pollAndFireDue(
        handler,
        new Date(now.getTime() + 49 * 60 * 60 * 1000),
      );
      expect(fired).toHaveLength(1);
    });
  });
});
