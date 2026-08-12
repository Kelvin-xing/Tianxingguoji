import { GuardianRelationshipPanel } from "@/components/crm/GuardianRelationshipPanel";

export default async function GuardianRelationshipsPage({
  params,
}: {
  readonly params: Promise<{ studentId: string }>;
}) {
  const { studentId } = await params;
  return <GuardianRelationshipPanel studentId={studentId} />;
}
