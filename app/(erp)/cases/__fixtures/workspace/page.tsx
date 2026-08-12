import { notFound } from "next/navigation";

import { CaseWorkspace } from "@/components/cases/CaseWorkspace";
import { createCaseWorkspaceVisualFixture } from "@/tests/fixtures/case-workspace";

export const dynamic = "force-dynamic";

export default async function CaseWorkspaceVisualFixturePage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly tab?: string }>;
}) {
  if (
    process.env.NODE_ENV !== "development" ||
    process.env.NEXT_PUBLIC_CASE_WORKSPACE_VISUAL_FIXTURE !== "true"
  ) {
    notFound();
  }
  const { tab } = await searchParams;
  return <CaseWorkspace projection={createCaseWorkspaceVisualFixture(tab)} />;
}
