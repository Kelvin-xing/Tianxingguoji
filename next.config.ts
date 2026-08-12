import type { NextConfig } from "next";

const GIT_SHA_PATTERN = /^[0-9a-f]{7,64}$/;
const DEPLOYMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const isProduction = process.env.NODE_ENV === "production";

function readBuildIdentity(
  name: "GIT_SHA" | "NEXT_DEPLOYMENT_ID",
  pattern: RegExp,
): string | undefined {
  const value = process.env[name]?.trim();

  if (value && !pattern.test(value)) {
    throw new Error(`${name} has an invalid production build identity format`);
  }

  if (isProduction && !value) {
    throw new Error(`${name} is required for a production multi-instance build`);
  }

  return value || undefined;
}

const gitSha = readBuildIdentity("GIT_SHA", GIT_SHA_PATTERN);
const deploymentId = readBuildIdentity("NEXT_DEPLOYMENT_ID", DEPLOYMENT_ID_PATTERN);

const nextConfig: NextConfig = {
  output: "standalone",
  generateBuildId: async () => gitSha ?? "development",
  ...(deploymentId ? { deploymentId } : {}),
};

export default nextConfig;
