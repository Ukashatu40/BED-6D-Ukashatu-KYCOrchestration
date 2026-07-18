import { CircuitBreaker, CircuitTransitionEvent } from './circuit-breaker';
import { describe, it, expect, jest } from '@jest/globals';

const config = {
  vendorType: 'TEST_VENDOR',
  failureThresholdPercent: 50,
  rollingWindowMs: 60_000,
  minimumRequestsInWindow: 4,
  openStateTimeoutMs: 30_000,
};

describe('CircuitBreaker', () => {
  it('starts CLOSED', () => {
    const cb = new CircuitBreaker(config);
    expect(cb.getState()).toBe('CLOSED');
  });

  it('passes through successful calls while CLOSED', async () => {
    const cb = new CircuitBreaker(config);
    const result = await cb.execute(async () => 'ok');
    expect(result).toBe('ok');
    expect(cb.getState()).toBe('CLOSED');
  });

  it('opens after failure rate exceeds threshold with minimum sample size', async () => {
    const cb = new CircuitBreaker(config);
    const fail = () =>
      cb
        .execute(async () => {
          throw new Error('vendor down');
        })
        .catch(() => {});

    await fail();
    await fail();
    expect(cb.getState()).toBe('CLOSED'); // below minimumRequestsInWindow

    await fail();
    await fail(); // 4 failures / 4 requests = 100% >= 50% threshold
    expect(cb.getState()).toBe('OPEN');
  });

  it('does not open below the minimum request sample size even at 100% failure', async () => {
    const cb = new CircuitBreaker({ ...config, minimumRequestsInWindow: 10 });
    const fail = () =>
      cb
        .execute(async () => {
          throw new Error('down');
        })
        .catch(() => {});
    await fail();
    await fail();
    expect(cb.getState()).toBe('CLOSED');
  });

  it('short-circuits immediately once OPEN, without invoking fn', async () => {
    const cb = new CircuitBreaker(config);
    const fn = jest.fn(async () => {
      throw new Error('down');
    });
    for (let i = 0; i < 4; i++) {
      await cb.execute(fn).catch(() => {});
    }
    expect(cb.getState()).toBe('OPEN');

    const callCountBeforeOpen = fn.mock.calls.length;
    await expect(cb.execute(fn)).rejects.toThrow('Circuit breaker OPEN');
    expect(fn.mock.calls.length).toBe(callCountBeforeOpen); // fn was NOT called
  });

  it('transitions to HALF_OPEN after the open-state timeout elapses', async () => {
    const cb = new CircuitBreaker({ ...config, openStateTimeoutMs: 10 });
    const fail = () =>
      cb
        .execute(async () => {
          throw new Error('down');
        })
        .catch(() => {});
    for (let i = 0; i < 4; i++) await fail();
    expect(cb.getState()).toBe('OPEN');

    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(cb.getState()).toBe('HALF_OPEN');
  });

  it('closes on a successful half-open probe', async () => {
    const cb = new CircuitBreaker({ ...config, openStateTimeoutMs: 10 });
    const fail = () =>
      cb
        .execute(async () => {
          throw new Error('down');
        })
        .catch(() => {});
    for (let i = 0; i < 4; i++) await fail();
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(cb.getState()).toBe('HALF_OPEN');

    await cb.execute(async () => 'recovered');
    expect(cb.getState()).toBe('CLOSED');
  });

  it('reopens on a failed half-open probe', async () => {
    const cb = new CircuitBreaker({ ...config, openStateTimeoutMs: 10 });
    const fail = () =>
      cb
        .execute(async () => {
          throw new Error('down');
        })
        .catch(() => {});
    for (let i = 0; i < 4; i++) await fail();
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(cb.getState()).toBe('HALF_OPEN');

    await cb
      .execute(async () => {
        throw new Error('still down');
      })
      .catch(() => {});
    expect(cb.getState()).toBe('OPEN');
  });

  it('rejects concurrent probes while HALF_OPEN', async () => {
    const cb = new CircuitBreaker({ ...config, openStateTimeoutMs: 10 });
    const fail = () =>
      cb
        .execute(async () => {
          throw new Error('down');
        })
        .catch(() => {});
    for (let i = 0; i < 4; i++) await fail();
    await new Promise((resolve) => setTimeout(resolve, 15));

    let resolveSlow: () => void;
    const slowProbe = cb.execute(
      () =>
        new Promise((resolve) => {
          resolveSlow = () => resolve('slow-ok');
        }),
    );
    // second probe while first is in flight
    await expect(cb.execute(async () => 'fast')).rejects.toThrow('probe already in flight');
    resolveSlow!();
    await slowProbe;
  });

  it('emits transition events with vendor type, from/to state, and reason', async () => {
    const cb = new CircuitBreaker(config);
    const events: CircuitTransitionEvent[] = [];
    cb.onTransition((e) => events.push(e));

    const fail = () =>
      cb
        .execute(async () => {
          throw new Error('down');
        })
        .catch(() => {});
    for (let i = 0; i < 4; i++) await fail();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      vendorType: 'TEST_VENDOR',
      fromState: 'CLOSED',
      toState: 'OPEN',
    });
    expect(events[0].reason).toContain('Failure rate');
  });

  it('resets the outcome window after closing', async () => {
    const cb = new CircuitBreaker({ ...config, openStateTimeoutMs: 10 });
    const fail = () =>
      cb
        .execute(async () => {
          throw new Error('down');
        })
        .catch(() => {});
    for (let i = 0; i < 4; i++) await fail();
    await new Promise((resolve) => setTimeout(resolve, 15));
    await cb.execute(async () => 'recovered'); // closes

    // Immediately failing once more should NOT re-open on stale outcomes
    await cb
      .execute(async () => {
        throw new Error('one-off');
      })
      .catch(() => {});
    expect(cb.getState()).toBe('CLOSED');
  });
});
