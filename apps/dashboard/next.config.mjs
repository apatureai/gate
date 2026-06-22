/** @type {import('next').NextConfig} */
const nextConfig = {
  // The @gate/* packages ship prebuilt ESM (dist), so no transpilePackages needed.
  // pg is a server-only dep; keep it external to the client bundle.
  // sharp is pulled in transitively by @gate/service -> @gate/delivery (used
  // only by the engine-side screenshot annotator, never on a dashboard path);
  // externalize it so Next doesn't try to bundle its optional native binaries.
  serverExternalPackages: ["pg", "sharp"],
};

export default nextConfig;
