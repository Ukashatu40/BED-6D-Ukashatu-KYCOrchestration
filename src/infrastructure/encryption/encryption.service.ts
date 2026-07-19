// src/infrastructure/encryption/encryption.service.ts
import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { KmsPort } from '../../application/ports/kms.port';

export interface EncryptedPayload {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

export interface EnvelopeEncryptedDocument {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  encryptedDek: Buffer;
  kekVersion: string;
}

const AES_KEY_LENGTH_BYTES = 32; // AES-256
const GCM_IV_LENGTH_BYTES = 12; // 96-bit IV per NIST SP 800-38D recommendation, referenced in Section E3

/**
 * Two-layer envelope encryption per Section A3.6 / ADR-003:
 * Layer 1 (Data Encryption): unique DEK per document, AES-256-GCM.
 * Layer 2 (Key Encryption): DEK wrapped by the KMS's current KEK.
 *
 * The plaintext DEK NEVER touches persistent storage or logs — it exists
 * only as a local variable for the duration of a single encrypt/decrypt
 * call and is explicitly zeroed afterward (Section A3.6's decryption flow:
 * "immediately zeroes the plaintext DEK from memory after use").
 */
export class EncryptionService {
  constructor(private readonly kms: KmsPort) {}

  generateDek(): Buffer {
    return randomBytes(AES_KEY_LENGTH_BYTES);
  }

  encrypt(plaintext: Buffer, dek: Buffer): EncryptedPayload {
    this.assertValidDekLength(dek);
    const iv = randomBytes(GCM_IV_LENGTH_BYTES);
    const cipher = createCipheriv('aes-256-gcm', dek, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return { ciphertext, iv, authTag };
  }

  decrypt(payload: EncryptedPayload, dek: Buffer): Buffer {
    this.assertValidDekLength(dek);
    const decipher = createDecipheriv('aes-256-gcm', dek, payload.iv);
    decipher.setAuthTag(payload.authTag);
    // If the ciphertext or authTag has been tampered with, this throws
    // (GCM authentication failure) rather than silently returning garbage —
    // this IS the tamper-detection mechanism ADR-003 relies on.
    return Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]);
  }

  /**
   * Full envelope encryption in one call: generates a fresh DEK, encrypts
   * the document with it, wraps the DEK via the KMS, and immediately
   * discards the plaintext DEK. Returns everything DocumentStorageService
   * needs to persist (ciphertext + iv + authTag + encryptedDek + kekVersion)
   * — nothing plaintext survives this method's return.
   */
  async encryptDocument(plaintext: Buffer): Promise<EnvelopeEncryptedDocument> {
    let dek: Buffer | null = this.generateDek();
    try {
      const { ciphertext, iv, authTag } = this.encrypt(plaintext, dek);
      const wrapped = await this.kms.wrapDek(dek);
      return {
        ciphertext,
        iv,
        authTag,
        encryptedDek: wrapped.encryptedDek,
        kekVersion: wrapped.kekVersion,
      };
    } finally {
      if (dek) {
        dek.fill(0); // zero the plaintext DEK from memory
        dek = null;
      }
    }
  }

  /**
   * Inverse of encryptDocument: unwraps the DEK via the KMS, decrypts,
   * zeroes the plaintext DEK immediately after use. The audit log entry
   * for this access is the caller's responsibility (DocumentStorageService)
   * — this service has no knowledge of "who" is accessing a document or
   * "why," only how to decrypt bytes given the right key material.
   */
  async decryptDocument(envelope: EnvelopeEncryptedDocument): Promise<Buffer> {
    let dek: Buffer | null = await this.kms.unwrapDek(envelope.encryptedDek, envelope.kekVersion);
    try {
      return this.decrypt(
        { ciphertext: envelope.ciphertext, iv: envelope.iv, authTag: envelope.authTag },
        dek,
      );
    } finally {
      if (dek) {
        dek.fill(0);
        dek = null;
      }
    }
  }

  private assertValidDekLength(dek: Buffer): void {
    if (dek.length !== AES_KEY_LENGTH_BYTES) {
      throw new Error(
        `DEK must be exactly ${AES_KEY_LENGTH_BYTES} bytes (AES-256), got ${dek.length}`,
      );
    }
  }
}
