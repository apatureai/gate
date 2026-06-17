import { buildServer } from "./app.js";

/** Process entrypoint used by the container (`fly.toml` CMD). */
const port = Number(process.env.PORT ?? 8080);
const app = buildServer({ logger: true });

app.listen({ host: "0.0.0.0", port }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
