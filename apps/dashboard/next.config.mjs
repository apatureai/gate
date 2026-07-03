import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: repoRoot,
  // The @gate/* packages ship prebuilt ESM (dist), so no transpilePackages needed.
  // pg is a server-only dep; keep it external to the client bundle.
  // sharp is used only by Gate's server-side screenshot annotator; keep it
  // external if a future server-only import path reaches that code.
  serverExternalPackages: ["pg", "sharp"],
};

export default nextConfig;
