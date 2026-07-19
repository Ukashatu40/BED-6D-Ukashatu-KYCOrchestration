// src/application/ports/object-store.port.ts
/**
 * Abstraction over the document object store (S3-compatible per spec's
 * Document Object Store section, p.55: path convention
 * /{environment}/{customer_id}/{document_type}/{document_id}.enc).
 * DocumentStorageService never talks to S3/MinIO/etc. directly.
 */
export interface ObjectStorePort {
  putObject(path: string, data: Buffer): Promise<void>;
  getObject(path: string): Promise<Buffer>;
}
