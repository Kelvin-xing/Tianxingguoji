import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { loadLocalSyntheticConfig } from "../lib/runtime/local-synthetic-config.ts";
import { getDueNotificationScheduleRuntime } from "../modules/notifications/server.ts";

const DEFAULT_INTERVAL_MS = 60_000;

export async function runNotificationScheduler(
  signal: Readonly<{ readonly stopped: () => boolean }> = processSignal(),
): Promise<void> {
  const config = loadLocalSyntheticConfig();
  if (!config.organizationId) throw new Error("LOCAL_SYNTHETIC_ORGANIZATION_ID is required for notification scheduling");
  const runtime = getDueNotificationScheduleRuntime(randomUUID());
  const intervalMs = readInterval(process.env.NOTIFICATION_SCHEDULER_INTERVAL_MS);
  process.stdout.write("notification-scheduler-ready\n");
  while (!signal.stopped()) {
    const result = await runtime.scheduler.runOnce({ organizationId: config.organizationId });
    process.stdout.write(`${JSON.stringify({ notification_scheduler: result })}\n`);
    if (signal.stopped()) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function readInterval(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_INTERVAL_MS;
  if (!/^\d+$/.test(value)) throw new Error("NOTIFICATION_SCHEDULER_INTERVAL_MS must be an integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 3_600_000) {
    throw new Error("NOTIFICATION_SCHEDULER_INTERVAL_MS is outside the allowed range");
  }
  return parsed;
}

function processSignal() {
  let stopped = false;
  process.once("SIGTERM", () => { stopped = true; });
  process.once("SIGINT", () => { stopped = true; });
  return { stopped: () => stopped };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runNotificationScheduler().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
