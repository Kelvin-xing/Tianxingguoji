import { F3TaskWorkspace } from '@/components/tasks/F3TaskWorkspace'
export default async function ContractorTaskPage({ params }: { params: Promise<{ taskId: string }> }) { const { taskId } = await params; return <F3TaskWorkspace taskId={taskId} contractor /> }
