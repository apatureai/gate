/** @type {import('next').NextConfig} */
const nextConfig = {
  // The @gate/* packages ship prebuilt ESM (dist), so no transpilePackages needed.
  // pg is a server-only dep; keep it external to the client bundle.
  serverExternalPackages: ["pg"],
};

export default nextConfig;
