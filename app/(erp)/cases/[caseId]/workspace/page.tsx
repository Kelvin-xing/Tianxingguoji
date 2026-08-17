import { randomUUID } from "node:crypto";

import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { CaseWorkspace } from "@/components/cases/CaseWorkspace";
import {
  parseCaseWorkspaceTab,
  type CaseWorkspaceProjection,
} from "@/components/cases/workspace-model";
import { SESSION_COOKIE_NAME } from "@/modules/identity/server";
import { IdentityRuntimeUnavailable, getIdentityRuntime } from "@/modules/identity/server";
import { IdentityServiceError } from "@/modules/identity/server";

export const dynamic = "force-dynamic";

interface PageProps {
  readonly params: Promise<{ readonly caseId: string }>;
  readonly searchParams: Promise<{ readonly tab?: string }>;
}

/**
 * This route intentionally has no fallback to the legacy case reads or P1
 * synthetic adapters. A future HK RDS composition must inject the one
 * authorized workspace projection before this flag can be enabled.
 */
export default async function CaseWorkspacePage({ params, searchParams }: PageProps) {
  if (process.env.CASE_WORKSPACE_ENABLED !== "true") notFound();

  const [{ caseId }, { tab }] = await Promise.all([params, searchParams]);
  if (!isUuid(caseId)) notFound();
  const activeTab = parseCaseWorkspaceTab(tab) ?? "overview";

  try {
    const sessionSecret = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
    if (!sessionSecret) redirect("/login");
    const actor = await getIdentityRuntime().service.requireSession({
      cookieSecret: sessionSecret,
      sensitiveAction: false,
    });
    if (actor.role === "contractor") notFound();
  } catch (error) {
    if (error instanceof IdentityServiceError) redirect("/login");
    if (!(error instanceof IdentityRuntimeUnavailable)) throw error;
  }

  return <CaseWorkspace projection={runtimeUnavailableProjection(caseId, activeTab)} />;
}

function runtimeUnavailableProjection(
  caseId: string,
  activeTab: NonNullable<ReturnType<typeof parseCaseWorkspaceTab>>,
): CaseWorkspaceProjection {
  const routeBase = `/cases/${caseId}/workspace`;
  return {
    routeBase,
    header: null,
    tabs: [],
    activeTab,
    panel: {
      kind: "error",
      title: "Case workspace is temporarily unavailable",
      detail: "The authorized case workspace projection is not configured.",
      requestReference: randomUUID(),
      retryHref: `${routeBase}?tab=${activeTab}`,
    },
    conflict: null,
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
