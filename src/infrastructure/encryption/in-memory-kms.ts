// src/infrastructure/encryption/in-memory-kms.ts
import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { KmsPort, WrappedKey } from '../../application/ports/kms.port';

/** Pure in-memory KMS fake for tests — same crypto behaviour as LocalFileKms, zero disk I/O. */
export class InMemoryKms implements KmsPort {
  private readonly keksByVersion = new Map<string, Buffer>();
  private currentVersion = 'v1';

  constructor() {
    this.keksByVersion.set(this.currentVersion, randomBytes(32));
  }

  wrapDek(plaintextDek: Buffer): Promise<WrappedKey> {
    const kek = this.requireKek(this.currentVersion);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', kek, iv);
    const encrypted = Buffer.concat([cipher.update(plaintextDek), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Promise.resolve({
      encryptedDek: Buffer.concat([iv, authTag, encrypted]),
      kekVersion: this.currentVersion,
    });
  }

  unwrapDek(encryptedDek: Buffer, kekVersion: string): Promise<Buffer> {
    const kek = this.requireKek(kekVersion);
    const iv = encryptedDek.subarray(0, 12);
    const authTag = encryptedDek.subarray(12, 28);
    const ciphertext = encryptedDek.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', kek, iv);
    decipher.setAuthTag(authTag);
    return Promise.resolve(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  }

  getCurrentKekVersion(): string {
    return this.currentVersion;
  }

  rotateKek(): string {
    const newVersion = `v${this.keksByVersion.size + 1}`;
    this.keksByVersion.set(newVersion, randomBytes(32));
    this.currentVersion = newVersion;
    return newVersion;
  }

  private requireKek(version: string): Buffer {
    const kek = this.keksByVersion.get(version);
    if (!kek) throw new Error(`No KEK found for version "${version}"`);
    return kek;
  }
}
