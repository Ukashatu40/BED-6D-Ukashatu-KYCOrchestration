// src/infrastructure/encryption/local-file-kms.ts
import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { KmsPort, WrappedKey } from '../../application/ports/kms.port';

interface KekRecord {
  version: string;
  key: Buffer; // 32 bytes, AES-256
}

/**
 * File-backed KMS simulation for local development and this project's
 * scope, matching the interface a real KMS would expose (Section A3.6:
 * "the KMS can be a local key store with the same interface as a real
 * KMS"). Supports multiple KEK versions so rotation can be exercised —
 * wrapDek always uses the current version; unwrapDek looks up whichever
 * version the caller specifies, so previously-wrapped DEKs remain
 * decryptable after rotation (ADR-003's "rotation re-wraps DEKs, not
 * documents" guarantee).
 *
 * NOT FOR PRODUCTION — a real deployment replaces this with an adapter
 * hitting AWS KMS/GCP Cloud KMS/Vault where the KEK material never touches
 * application disk at all. Flagging explicitly per the AI-usage disclosure
 * requirement (Section E5, Rule 4) and so this isn't mistaken for a
 * hardened implementation during review.
 */
export class LocalFileKms implements KmsPort {
  private readonly keksByVersion = new Map<string, Buffer>();
  private currentVersion: string;

  constructor(private readonly keyStorePath: string) {
    this.currentVersion = this.loadOrCreateKeyStore();
  }

  wrapDek(plaintextDek: Buffer): Promise<WrappedKey> {
    const kek = this.requireKek(this.currentVersion);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', kek, iv);
    const encrypted = Buffer.concat([cipher.update(plaintextDek), cipher.final()]);
    const authTag = cipher.getAuthTag();
    // Store iv + authTag alongside ciphertext so unwrapDek is self-contained
    // given just (encryptedDek, kekVersion) — matches the port's signature.
    const encryptedDek = Buffer.concat([iv, authTag, encrypted]);
    return Promise.resolve({ encryptedDek, kekVersion: this.currentVersion });
  }

  unwrapDek(encryptedDek: Buffer, kekVersion: string): Promise<Buffer> {
    const kek = this.requireKek(kekVersion);
    const iv = encryptedDek.subarray(0, 12);
    const authTag = encryptedDek.subarray(12, 28);
    const ciphertext = encryptedDek.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', kek, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return Promise.resolve(plaintext);
  }

  getCurrentKekVersion(): string {
    return this.currentVersion;
  }

  /** Generates a new KEK version and makes it current. Existing wrapped DEKs under old versions remain decryptable — nothing is re-encrypted here (that's the optional background re-wrapping job per ADR-003). */
  rotateKek(): string {
    const newVersion = `v${this.keksByVersion.size + 1}`;
    this.keksByVersion.set(newVersion, randomBytes(32));
    this.currentVersion = newVersion;
    this.persist();
    return newVersion;
  }

  private requireKek(version: string): Buffer {
    const kek = this.keksByVersion.get(version);
    if (!kek) {
      throw new Error(`No KEK found for version "${version}" — cannot wrap/unwrap`);
    }
    return kek;
  }

  private loadOrCreateKeyStore(): string {
    if (existsSync(this.keyStorePath)) {
      let raw: { currentVersion?: string; keks?: Array<{ version: string; keyBase64: string }> };
      try {
        raw = JSON.parse(readFileSync(this.keyStorePath, 'utf-8'));
      } catch (err) {
        throw new Error(
          `Keystore file at ${this.keyStorePath} exists but is not valid JSON. ` +
            `Delete it to force regeneration (dev only — never do this against a real KEK in production). Original error: ${err}`,
        );
      }
      if (!raw.currentVersion || !Array.isArray(raw.keks) || raw.keks.length === 0) {
        throw new Error(
          `Keystore file at ${this.keyStorePath} is missing "currentVersion" or "keks" — malformed or from an incompatible version. ` +
            `Delete it to force regeneration (dev only).`,
        );
      }
      for (const entry of raw.keks) {
        this.keksByVersion.set(entry.version, Buffer.from(entry.keyBase64, 'base64'));
      }
      return raw.currentVersion;
    }
    const version = 'v1';
    this.keksByVersion.set(version, randomBytes(32));
    this.persist();
    return version;
  }

  private persist(): void {
    const dir = dirname(this.keyStorePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const serialisable = {
      currentVersion: this.currentVersion,
      keks: Array.from(this.keksByVersion.entries()).map(([version, key]) => ({
        version,
        keyBase64: key.toString('base64'),
      })),
    };
    writeFileSync(this.keyStorePath, JSON.stringify(serialisable, null, 2), { mode: 0o600 });
  }
}
