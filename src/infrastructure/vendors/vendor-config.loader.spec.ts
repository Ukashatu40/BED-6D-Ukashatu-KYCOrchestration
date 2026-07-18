// src/infrastructure/vendors/vendor-config.loader.spec.ts
import { resolveCredentials } from './vendor-config.loader';
import { describe, expect, it, beforeEach } from '@jest/globals';

describe('resolveCredentials', () => {
  beforeEach(() => {
    delete process.env.SOME_TEST_SECRET;
  });

  it('resolves an env var to its value', () => {
    process.env.SOME_TEST_SECRET = 'the-actual-secret';
    const resolved = resolveCredentials({ apiKey: 'SOME_TEST_SECRET' }, true, 'TEST_VENDOR');
    expect(resolved.apiKey).toBe('the-actual-secret');
  });

  it('throws when a required env var is unset for an enabled vendor', () => {
    expect(() => resolveCredentials({ apiKey: 'SOME_TEST_SECRET' }, true, 'TEST_VENDOR')).toThrow(
      /Missing required environment variable/,
    );
  });

  it('does not throw for a missing env var on a disabled vendor', () => {
    expect(() =>
      resolveCredentials({ apiKey: 'SOME_TEST_SECRET' }, false, 'TEST_VENDOR'),
    ).not.toThrow();
  });
});
