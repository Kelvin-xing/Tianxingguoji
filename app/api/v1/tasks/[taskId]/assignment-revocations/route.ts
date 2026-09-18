import { getTaskWorkflowRuntime } from "@/modules/tasks/server";
import { requireIdentityActor } from "@/modules/identity/web";
import { createRequestContext,errorResponse,successResponse } from "@/modules/shared/public";
import { acknowledgementData,mapTaskError,parseCompletedAssignmentRevocation } from "../../handler.ts";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(request:Request,context:{readonly params:Promise<{readonly taskId:string}>}):Promise<Response>{
  const requestContext=createRequestContext(request);
  try {
    const {taskId}=await context.params;
    const command=await parseCompletedAssignmentRevocation(request,taskId,requestContext.requestId);
    const result=await getTaskWorkflowRuntime().service.revokeCompletedAssignment({actor:await requireIdentityActor(),taskId,command});
    return successResponse(requestContext,acknowledgementData(result));
  } catch(error){return errorResponse(requestContext,mapTaskError(error));}
}
