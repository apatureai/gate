import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { KmsKeyProvider } from "./kms.js";

/**
 * Envelope-encrypted secret at rest (TRD §8, §12). The plaintext is encrypted
 * with a fresh per-secret DEK (AES-256-GCM); the DEK is wrapped under the CMK
 * named by `keyId`. Only this envelope is persisted; plaintext exists only at
 * point of use. Used for per-repo `protection_bypass` and `storageState`.
 */
export interface SealedSecret {
  /** CMK id the DEK is wrapped under (shared or per-tenant). */
  keyId: string;
  /** Base64 wrapped DEK. */
  wrappedDek: string;
  /** Base64 AES-GCM IV. */
  iv: string;
  /** Base64 AES-GCM auth tag. */
  authTag: string;
  /** Base64 ciphertext. */
  ciphertext: string;
}

/** Encrypt a plaintext secret into a `SealedSecret`. */
export async function sealSecret(
  plaintext: string,
  keyId: string,
  kms: KmsKeyProvider,
): Promise<SealedSecret> {
  const dek = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dek, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const wrappedDek = await kms.wrapDataKey(dek, keyId);
  dek.fill(0); // best-effort scrub of the raw DEK

  return {
    keyId,
    wrappedDek: wrappedDek.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

/** Decrypt a `SealedSecret` back to plaintext at point of use. */
export async function openSecret(sealed: SealedSecret, kms: KmsKeyProvider): Promise<string> {
  const dek = await kms.unwrapDataKey(Buffer.from(sealed.wrappedDek, "base64"), sealed.keyId);
  try {
    const decipher = createDecipheriv("aes-256-gcm", dek, Buffer.from(sealed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(sealed.authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, "base64")),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } finally {
    dek.fill(0);
  }
}
