const EXPECTED_NODE_MAJOR = 22;
const EXPECTED_PNPM_VERSION = "10.34.4";

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
if (nodeMajor !== EXPECTED_NODE_MAJOR) {
  throw new Error(
    `Node.js ${EXPECTED_NODE_MAJOR}.x is required; received ${process.versions.node}.`,
  );
}

const packageManager = process.env.npm_config_user_agent?.split(" ")[0];
if (packageManager?.startsWith("pnpm/") && packageManager !== `pnpm/${EXPECTED_PNPM_VERSION}`) {
  throw new Error(
    `pnpm ${EXPECTED_PNPM_VERSION} is required; received ${packageManager.slice("pnpm/".length)}.`,
  );
}

console.log(`toolchain: Node.js ${process.versions.node}, pnpm ${EXPECTED_PNPM_VERSION}`);
