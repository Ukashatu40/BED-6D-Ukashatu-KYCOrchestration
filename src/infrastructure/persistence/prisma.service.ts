// src/infrastructure/persistence/prisma.service.ts
import { PrismaClient } from '@prisma/client';

/**
 * Thin wrapper so the rest of the codebase depends on this class, not
 * directly on @prisma/client — keeps the door open to swap ORMs later
 * without touching every repository, and gives one place to hook
 * connection lifecycle (Nest's OnModuleInit/OnModuleDestroy wiring happens
 * where this is provided, in the API layer's module setup).
 */
export class PrismaService extends PrismaClient {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
