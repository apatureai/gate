import { createProductionAppServer, type ProductionAppServerDeps } from "./production-server.js";

/**
 * Process entrypoint used by the container (`fly.toml` CMD). The live App-path is
 * assembled by `createProductionAppServer` (#62); this entrypoint only builds the
 * infra-bound deps from the environment and starts listening.
 *
 * Constructing those deps — the KMS-backed `SecretStore` -> `createGitHubAppAuth`
 * -> per-installation `createAppReviewClient`/`createGitHubPullsClient`, the
 * per-account engine transport, and the Redis/SQL stores -> requires live
 * Postgres/Redis/Fly/secrets and is the **go-live ops step (#64)**: wire
 * `buildProductionDepsFromEnv` to the provisioned services there. Keeping it one
 * clearly-marked seam (not scattered `process.env` reads) keeps the composition
 * root above fully testable with fakes + a mock engine.
 */
function buildProductionDepsFromEnv(): ProductionAppServerDeps {
  throw new Error(
    "buildProductionDepsFromEnv is the go-live ops step (#64): wire the KMS SecretStore, " +
      "GitHub App auth, per-account engine transport, and Redis/SQL stores to the provisioned " +
      "services. The composition root (createProductionAppServer) is implemented and tested (#62).",
  );
}

const port = Number(process.env.PORT ?? 8080);
createProductionAppServer(buildProductionDepsFromEnv())
  .start({ host: "0.0.0.0", port })
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
