import { App } from "@octokit/app";

/**
 * GitHub App authentication via @octokit/app (TRD §2): app-JWT minting and
 * installation-token caching (the library caches installation tokens until they
 * near expiry, so we don't hand-roll it). The private key + webhook secret come
 * from the KMS-backed store (`@gate/secrets`).
 */
export interface GitHubAppAuth {
  /** Cached installation access token, scoped to one installation. */
  getInstallationToken(installationId: number): Promise<string>;
  /** Mint an app-level JWT (offline; no network). */
  mintAppJwt(): Promise<string>;
}

export interface GitHubAppAuthOptions {
  appId: string | number;
  privateKey: string;
  webhookSecret?: string;
}

export function createGitHubAppAuth(options: GitHubAppAuthOptions): GitHubAppAuth {
  const app = new App({
    appId: options.appId,
    privateKey: options.privateKey,
    ...(options.webhookSecret ? { webhooks: { secret: options.webhookSecret } } : {}),
  });

  return {
    async getInstallationToken(installationId) {
      const octokit = await app.getInstallationOctokit(installationId);
      const auth = (await octokit.auth({ type: "installation" })) as { token: string };
      return auth.token;
    },
    async mintAppJwt() {
      const auth = (await app.octokit.auth({ type: "app" })) as { token: string };
      return auth.token;
    },
  };
}
