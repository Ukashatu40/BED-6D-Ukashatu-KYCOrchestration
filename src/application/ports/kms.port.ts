// src/application/ports/kms.port.ts
export interface WrappedKey {
  encryptedDek: Buffer;
  kekVersion: string;
}

/**
 * Boundary around Key Management. The KEK itself never crosses this
 * interface in either direction — only encrypt(plaintext DEK) -> wrapped,
 * and decrypt(wrapped) -> plaintext DEK. Per ADR-003, this port lets the
 * local file-based simulation used for this project be swapped for AWS
 * KMS/GCP Cloud KMS/HashiCorp Vault in production with zero changes to
 * EncryptionService or DocumentStorageService.
 */
export interface KmsPort {
  wrapDek(plaintextDek: Buffer): Promise<WrappedKey>;
  unwrapDek(encryptedDek: Buffer, kekVersion: string): Promise<Buffer>;
  getCurrentKekVersion(): string;
}
