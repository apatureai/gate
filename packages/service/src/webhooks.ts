import { Webhooks } from "@octokit/webhooks";

/**
 * GitHub webhook HMAC verification via @octokit/webhooks (TRD §2, §8). Verifies
 * the `x-hub-signature-256` over the raw body so a forged or unsigned delivery is
 * rejected before any work. The secret comes from the KMS-backed store
 * (`@gate/secrets` `webhookSecret`).
 */
export interface WebhookVerifier {
  verify(rawBody: string, signature: string | undefined): Promise<boolean>;
}

export function createWebhookVerifier(secret: string): WebhookVerifier {
  const webhooks = new Webhooks({ secret });
  return {
    async verify(rawBody, signature) {
      if (!signature) return false;
      try {
        return await webhooks.verify(rawBody, signature);
      } catch {
        return false;
      }
    },
  };
}
