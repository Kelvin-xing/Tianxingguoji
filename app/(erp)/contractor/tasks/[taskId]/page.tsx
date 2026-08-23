import { redirect } from "next/navigation";

interface PageProps {
  readonly params: Promise<{ readonly taskId: string }>;
}

export default async function ContractorTaskPage({ params }: PageProps) {
  const { taskId } = await params;
  redirect(`/tasks/${taskId}`);
}
