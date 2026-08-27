import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { loadLocalSyntheticConfig } from "../lib/runtime/local-synthetic-config.ts";
import { deliverNextInAppNotification } from "./deliver-in-app.ts";

/** Local worker entrypoint used by the focused BE-07 PostgreSQL gate. */
export async function runNotificationWorker(
  signal: Readonly<{ readonly stopped: () => boolean }> = processSignal(),
): Promise<void> {
  const config = loadLocalSyntheticConfig();
  if (!config.organizationId) throw new Error("LOCAL_SYNTHETIC_ORGANIZATION_ID is required for notifications");
  const workerId = randomUUID();
  process.stdout.write("notification-worker-ready\n");
  while (!signal.stopped()) {
    await deliverNextInAppNotification({ workerId });
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function processSignal() {
  let stopped = false;
  process.once("SIGTERM", () => { stopped = true; });
  process.once("SIGINT", () => { stopped = true; });
  return { stopped: () => stopped };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runNotificationWorker().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
