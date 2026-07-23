// src/infrastructure/persistence/in-memory-data-erasure-repository.ts
import {
  DataErasureRepositoryPort,
  DataErasureRequestRecord,
} from '../../application/ports/data-erasure-repository.port';

export class InMemoryDataErasureRepository implements DataErasureRepositoryPort {
  private readonly records = new Map<string, DataErasureRequestRecord>();

  async save(record: DataErasureRequestRecord): Promise<void> {
    this.records.set(record.requestId, { ...record });
  }

  async findById(requestId: string): Promise<DataErasureRequestRecord | null> {
    return this.records.get(requestId) ?? null;
  }
}
