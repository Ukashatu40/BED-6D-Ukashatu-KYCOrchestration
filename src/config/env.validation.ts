// src/config/env.validation.ts
/**
 * Validates required environment variables at bootstrap — fails fast with
 * a clear error rather than letting a missing DATABASE_URL or JWT_SECRET
 * surface as a mysterious runtime crash three requests into the app's
 * life. Mirrors the same "fail loudly and early" philosophy as
 * loadVendorsConfig (Day 2) and loadWorkflowConfig (Day 3).
 */
export interface AppEnv {
  NODE_ENV: string;
  PORT: number;
  DATABASE_URL: string;
  REDIS_HOST: string;
  REDIS_PORT: number;
  JWT_SECRET: string;
  JWT_EXPIRES_IN: string;
  KMS_MASTER_KEY_PATH: string;
}

const REQUIRED_KEYS: Array<keyof AppEnv> = [
  'DATABASE_URL',
  'REDIS_HOST',
  'REDIS_PORT',
  'JWT_SECRET',
  'KMS_MASTER_KEY_PATH',
];

export function validateEnv(config: Record<string, unknown>): AppEnv {
  const missing = REQUIRED_KEYS.filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  return {
    NODE_ENV: (config.NODE_ENV as string) ?? 'development',
    PORT: Number(config.PORT ?? 3000),
    DATABASE_URL: config.DATABASE_URL as string,
    REDIS_HOST: config.REDIS_HOST as string,
    REDIS_PORT: Number(config.REDIS_PORT),
    JWT_SECRET: config.JWT_SECRET as string,
    JWT_EXPIRES_IN: (config.JWT_EXPIRES_IN as string) ?? '1h',
    KMS_MASTER_KEY_PATH: config.KMS_MASTER_KEY_PATH as string,
  };
}
