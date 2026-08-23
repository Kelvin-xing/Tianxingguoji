import { getTaskWorkflowRuntime } from "@/modules/tasks/server";
import { requireIdentityActor } from "@/modules/identity/web";
import { createRequestContext,errorResponse,successResponse } from "@/modules/shared/public";
import { acknowledgementData,mapTaskError,parseTaskTransition } from "../../handler.ts";
export const runtime="nodejs";export const dynamic="force-dynamic";type Context={readonly params:Promise<{readonly taskId:string}>};
export async function POST(request:Request,context:Context):Promise<Response>{const requestContext=createRequestContext(request);try{const{taskId}=await context.params;
  const command=await parseTaskTransition(request,taskId,requestContext.requestId);const result=await getTaskWorkflowRuntime().service.transition({actor:await requireIdentityActor(),taskId,command});
  return successResponse(requestContext,acknowledgementData(result));}catch(error){return errorResponse(requestContext,mapTaskError(error));}}
