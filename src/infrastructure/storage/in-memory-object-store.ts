// src/infrastructure/storage/in-memory-object-store.ts
import { ObjectStorePort } from '../../application/ports/object-store.port';

/** Test/dev fake. Production adapter is an S3-compatible client (Day 4 infra hardening). */
export class InMemoryObjectStore implements ObjectStorePort {
  private readonly objects = new Map<string, Buffer>();

  async putObject(path: string, data: Buffer): Promise<void> {
    this.objects.set(path, Buffer.from(data));
  }

  async getObject(path: string): Promise<Buffer> {
    const data = this.objects.get(path);
    if (!data) {
      throw new Error(`No object found at path "${path}"`);
    }
    return Buffer.from(data);
  }
}
