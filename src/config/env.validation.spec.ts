// src/config/env.validation.spec.ts
import { validateEnv } from './env.validation';
import { describe, it, expect } from '@jest/globals';

describe('validateEnv', () => {
  const validConfig = {
    DATABASE_URL: 'postgresql://x',
    REDIS_HOST: 'localhost',
    REDIS_PORT: '6379',
    JWT_SECRET: 'secret',
    KMS_MASTER_KEY_PATH: './key',
  };

  it('returns a fully-populated AppEnv for valid input', () => {
    const env = validateEnv(validConfig);
    expect(env.REDIS_PORT).toBe(6379);
    expect(env.PORT).toBe(3000); // default applied
  });

  it('throws listing every missing required key', () => {
    expect(() => validateEnv({ DATABASE_URL: 'x' })).toThrow(
      /REDIS_HOST, REDIS_PORT, JWT_SECRET, KMS_MASTER_KEY_PATH/,
    );
  });

  it('applies the JWT_EXPIRES_IN default when not provided', () => {
    const env = validateEnv(validConfig);
    expect(env.JWT_EXPIRES_IN).toBe('1h');
  });
});
