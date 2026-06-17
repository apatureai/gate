import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@gate/action": fromRoot("./packages/action/src/index.ts"),
      "@gate/config": fromRoot("./packages/config/src/index.ts"),
      "@gate/db": fromRoot("./packages/db/src/index.ts"),
      "@gate/delivery": fromRoot("./packages/delivery/src/index.ts"),
      "@gate/engine": fromRoot("./packages/engine/src/index.ts"),
      "@gate/observability": fromRoot("./packages/observability/src/index.ts"),
      "@gate/redis": fromRoot("./packages/redis/src/index.ts"),
      "@gate/secrets": fromRoot("./packages/secrets/src/index.ts"),
      "@gate/service": fromRoot("./packages/service/src/index.ts"),
      "@gate/types": fromRoot("./packages/types/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
  },
});
