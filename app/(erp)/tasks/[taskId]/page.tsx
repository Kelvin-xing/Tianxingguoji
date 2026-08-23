import { TaskDetailView } from "@/components/tasks/TaskDetailView";

export default async function TaskDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly taskId: string }>;
}) {
  const { taskId } = await params;
  return <TaskDetailView taskId={taskId} />;
}
