import type { NextConfig } from "next";

const GIT_SHA_PATTERN = /^[0-9a-f]{7,64}$/;
const DEPLOYMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const isProduction = process.env.NODE_ENV === "production";
const UUID_PATH = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export const DOCUMENT_TRANSFER_PRIVATE_REQUEST_PATTERNS = Object.freeze([
  new RegExp(
    `^/api/v1/cases/${UUID_PATH}/documents/${UUID_PATH}/versions/${UUID_PATH}/upload-intents(?:\\?.*)?$`,
    "i",
  ),
  new RegExp(
    `^/api/v1/cases/${UUID_PATH}/documents/${UUID_PATH}/versions/${UUID_PATH}/abandonments(?:\\?.*)?$`,
    "i",
  ),
]);

function readBuildIdentity(
  name: "GIT_SHA" | "NEXT_DEPLOYMENT_ID",
  vercelName: "VERCEL_GIT_COMMIT_SHA" | "VERCEL_DEPLOYMENT_ID",
  pattern: RegExp,
): string | undefined {
  const value = process.env[name]?.trim() || process.env[vercelName]?.trim();

  if (value && !pattern.test(value)) {
    throw new Error(`${name} has an invalid production build identity format`);
  }

  if (isProduction && !value) {
    throw new Error(`${name} is required for a production multi-instance build`);
  }

  return value || undefined;
}

const gitSha = readBuildIdentity(
  "GIT_SHA",
  "VERCEL_GIT_COMMIT_SHA",
  GIT_SHA_PATTERN,
);
const deploymentId = readBuildIdentity(
  "NEXT_DEPLOYMENT_ID",
  "VERCEL_DEPLOYMENT_ID",
  DEPLOYMENT_ID_PATTERN,
);

const nextConfig: NextConfig = {
  output: "standalone",
  logging: {
    incomingRequests: {
      ignore: [...DOCUMENT_TRANSFER_PRIVATE_REQUEST_PATTERNS],
    },
  },
  generateBuildId: async () => gitSha ?? "development",
  ...(deploymentId ? { deploymentId } : {}),
};

export default nextConfig;
