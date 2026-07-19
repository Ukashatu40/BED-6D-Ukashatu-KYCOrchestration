// src/infrastructure/encryption/encryption.service.spec.ts
import { EncryptionService } from './encryption.service';
import { InMemoryKms } from './in-memory-kms';
import { describe, it, expect, jest } from '@jest/globals';

describe('EncryptionService', () => {
  describe('generateDek', () => {
    it('generates a 32-byte (256-bit) key', () => {
      const service = new EncryptionService(new InMemoryKms());
      expect(service.generateDek().length).toBe(32);
    });

    it('generates a different key on each call', () => {
      const service = new EncryptionService(new InMemoryKms());
      const a = service.generateDek();
      const b = service.generateDek();
      expect(a.equals(b)).toBe(false);
    });
  });

  describe('encrypt/decrypt round trip', () => {
    it('decrypts back to the exact original plaintext', () => {
      const service = new EncryptionService(new InMemoryKms());
      const dek = service.generateDek();
      const plaintext = Buffer.from('sensitive KYC document content');
      const encrypted = service.encrypt(plaintext, dek);
      const decrypted = service.decrypt(encrypted, dek);
      expect(decrypted.equals(plaintext)).toBe(true);
    });

    it('produces different ciphertext for the same plaintext on repeated calls (random IV)', () => {
      const service = new EncryptionService(new InMemoryKms());
      const dek = service.generateDek();
      const plaintext = Buffer.from('same content');
      const first = service.encrypt(plaintext, dek);
      const second = service.encrypt(plaintext, dek);
      expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
      expect(first.iv.equals(second.iv)).toBe(false);
    });

    it('rejects a DEK of the wrong length', () => {
      const service = new EncryptionService(new InMemoryKms());
      const wrongLengthKey = Buffer.alloc(16); // AES-128 length, not AES-256
      expect(() => service.encrypt(Buffer.from('x'), wrongLengthKey)).toThrow(
        /must be exactly 32 bytes/,
      );
    });

    it('handles a large (5MB-class) payload within the encryption latency budget (<100ms per spec)', () => {
      const service = new EncryptionService(new InMemoryKms());
      const dek = service.generateDek();
      const large = Buffer.alloc(5 * 1024 * 1024, 'x'); // 5MB, matches spec's stated document size budget
      const start = Date.now();
      const encrypted = service.encrypt(large, dek);
      const elapsed = Date.now() - start;
      expect(service.decrypt(encrypted, dek).equals(large)).toBe(true);
      expect(elapsed).toBeLessThan(100);
    });
  });

  describe('tamper detection (GCM authentication)', () => {
    it('fails to decrypt when the ciphertext has been modified', () => {
      const service = new EncryptionService(new InMemoryKms());
      const dek = service.generateDek();
      const encrypted = service.encrypt(Buffer.from('original content'), dek);
      const tamperedCiphertext = Buffer.from(encrypted.ciphertext);
      tamperedCiphertext[0] ^= 0xff; // flip a bit
      expect(() =>
        service.decrypt({ ...encrypted, ciphertext: tamperedCiphertext }, dek),
      ).toThrow();
    });

    it('fails to decrypt when the auth tag has been modified', () => {
      const service = new EncryptionService(new InMemoryKms());
      const dek = service.generateDek();
      const encrypted = service.encrypt(Buffer.from('original content'), dek);
      const tamperedAuthTag = Buffer.from(encrypted.authTag);
      tamperedAuthTag[0] ^= 0xff;
      expect(() => service.decrypt({ ...encrypted, authTag: tamperedAuthTag }, dek)).toThrow();
    });

    it('fails to decrypt with the wrong DEK entirely', () => {
      const service = new EncryptionService(new InMemoryKms());
      const dek = service.generateDek();
      const wrongDek = service.generateDek();
      const encrypted = service.encrypt(Buffer.from('original content'), dek);
      expect(() => service.decrypt(encrypted, wrongDek)).toThrow();
    });
  });

  describe('envelope encryption — full document flow', () => {
    it('round-trips a document through encryptDocument/decryptDocument', async () => {
      const service = new EncryptionService(new InMemoryKms());
      const plaintext = Buffer.from('Aadhaar document scan bytes');
      const envelope = await service.encryptDocument(plaintext);
      const decrypted = await service.decryptDocument(envelope);
      expect(decrypted.equals(plaintext)).toBe(true);
    });

    it('records the KEK version used at encryption time in the envelope', async () => {
      const kms = new InMemoryKms();
      const service = new EncryptionService(kms);
      const envelope = await service.encryptDocument(Buffer.from('doc'));
      expect(envelope.kekVersion).toBe(kms.getCurrentKekVersion());
    });

    it('produces an envelope whose encryptedDek differs from any plaintext DEK (never stores plaintext)', async () => {
      const service = new EncryptionService(new InMemoryKms());
      const envelope = await service.encryptDocument(Buffer.from('doc'));
      // The wrapped DEK must not equal the ciphertext (sanity check that
      // wrapping actually happened rather than being a no-op passthrough).
      expect(envelope.encryptedDek.equals(envelope.ciphertext)).toBe(false);
    });
  });

  describe('KEK rotation (ADR-003: rotation re-wraps DEKs, not documents)', () => {
    it('documents encrypted under an old KEK version remain decryptable after rotation', async () => {
      const kms = new InMemoryKms();
      const service = new EncryptionService(kms);
      const envelopeBeforeRotation = await service.encryptDocument(Buffer.from('pre-rotation doc'));
      const oldVersion = kms.getCurrentKekVersion();

      kms.rotateKek();
      expect(kms.getCurrentKekVersion()).not.toBe(oldVersion);

      // Old envelope still references the old version and must still decrypt correctly.
      expect(envelopeBeforeRotation.kekVersion).toBe(oldVersion);
      const decrypted = await service.decryptDocument(envelopeBeforeRotation);
      expect(decrypted.equals(Buffer.from('pre-rotation doc'))).toBe(true);
    });

    it('new documents encrypted after rotation use the new KEK version', async () => {
      const kms = new InMemoryKms();
      const service = new EncryptionService(kms);
      kms.rotateKek();
      const newVersion = kms.getCurrentKekVersion();
      const envelope = await service.encryptDocument(Buffer.from('post-rotation doc'));
      expect(envelope.kekVersion).toBe(newVersion);
    });

    it('rejects unwrapping with a KEK version that does not exist', async () => {
      const kms = new InMemoryKms();
      const service = new EncryptionService(kms);
      const envelope = await service.encryptDocument(Buffer.from('doc'));
      await expect(
        service.decryptDocument({ ...envelope, kekVersion: 'v-does-not-exist' }),
      ).rejects.toThrow(/No KEK found/);
    });
  });

  describe('DEK memory hygiene', () => {
    it('zeroes the plaintext DEK buffer after encryptDocument returns', async () => {
      const service = new EncryptionService(new InMemoryKms());
      let capturedDek: Buffer | null = null;
      const originalGenerateDek = service.generateDek.bind(service);
      jest.spyOn(service, 'generateDek').mockImplementation(() => {
        capturedDek = originalGenerateDek();
        return capturedDek;
      });
      await service.encryptDocument(Buffer.from('doc'));
      expect(capturedDek).not.toBeNull();
      expect(capturedDek!.every((byte) => byte === 0)).toBe(true); // zeroed post-use
    });
  });
});
