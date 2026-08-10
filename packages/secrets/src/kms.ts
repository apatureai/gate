import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

/**
 * KMS seam for wrapping per-repo data keys (DEKs) under a customer master key
 * (CMK), per the §15.3/§15.6 hierarchy:
 *
 *   shared CMK (free tier) / per-tenant CMK (paid) / per-repo DEK (always)
 *
 * We never create per-repo KMS keys (a cost trap at thousands of repos). `keyId`
 * identifies the CMK (shared or per-tenant); the DEK is generated per seal.
 * Production binds this to AWS KMS; `LocalKms` is the dev/test implementation.
 */
export interface KmsKeyProvider {
  /** Encrypt a raw DEK under the CMK identified by `keyId`. */
  wrapDataKey(plaintextDek: Buffer, keyId: string): Promise<Buffer>;
  /** Decrypt a wrapped DEK under the CMK identified by `keyId`. */
  unwrapDataKey(wrappedDek: Buffer, keyId: string): Promise<Buffer>;
}

/**
 * Local KMS for dev/tests. Derives a per-`keyId` CMK from a root key via HKDF
 * and wraps DEKs with AES-256-GCM. Not for production; real deployments use a
 * managed KMS (AWS KMS / Cloud KMS).
 */
export class LocalKms implements KmsKeyProvider {
  private readonly rootKey: Buffer;

  constructor(rootKey: Buffer) {
    if (rootKey.length < 32) {
      throw new Error("LocalKms root key must be at least 32 bytes");
    }
    this.rootKey = rootKey;
  }

  static fromPassphrase(passphrase: string): LocalKms {
    return new LocalKms(createHash("sha256").update(passphrase, "utf8").digest());
  }

  private cmk(keyId: string): Buffer {
    return Buffer.from(
      hkdfSync("sha256", this.rootKey, Buffer.from(keyId, "utf8"), Buffer.from("gate-cmk"), 32),
    );
  }

  async wrapDataKey(plaintextDek: Buffer, keyId: string): Promise<Buffer> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.cmk(keyId), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintextDek), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }

  async unwrapDataKey(wrappedDek: Buffer, keyId: string): Promise<Buffer> {
    const iv = wrappedDek.subarray(0, 12);
    const authTag = wrappedDek.subarray(12, 28);
    const ciphertext = wrappedDek.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", this.cmk(keyId), iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}
