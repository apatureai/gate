import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { KmsKeyProvider } from "./kms.js";

/**
 * Per-tenant key management for crypto-shredding (TRD §8, §15.6). Paid/enterprise
 * tenants get a per-tenant CMK; destroying it makes everything encrypted under it
 * unrecoverable (crypto-shred). Free-tier tenants share a CMK, so their deletion
 * guarantee is row-level only. Production binds this to AWS KMS
 * (ScheduleKeyDeletion); `InMemoryTenantKms` is the dev/test implementation.
 */
export interface TenantKeyManager {
  /** Permanently destroy a tenant CMK (crypto-shred). */
  destroyTenantKey(keyId: string): Promise<void>;
}

export class InMemoryTenantKms implements KmsKeyProvider, TenantKeyManager {
  private readonly keys = new Map<string, Buffer>();
  private readonly destroyed = new Set<string>();

  private keyFor(keyId: string): Buffer {
    if (this.destroyed.has(keyId)) {
      throw new Error(`tenant key ${keyId} has been crypto-shredded`);
    }
    let key = this.keys.get(keyId);
    if (!key) {
      key = randomBytes(32);
      this.keys.set(keyId, key);
    }
    return key;
  }

  async wrapDataKey(plaintextDek: Buffer, keyId: string): Promise<Buffer> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.keyFor(keyId), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintextDek), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }

  async unwrapDataKey(wrappedDek: Buffer, keyId: string): Promise<Buffer> {
    const key = this.keyFor(keyId); // throws if shredded
    const iv = wrappedDek.subarray(0, 12);
    const authTag = wrappedDek.subarray(12, 28);
    const ciphertext = wrappedDek.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  async destroyTenantKey(keyId: string): Promise<void> {
    this.keys.delete(keyId);
    this.destroyed.add(keyId);
  }
}
