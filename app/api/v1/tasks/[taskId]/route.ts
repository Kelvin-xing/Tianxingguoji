import { getTaskWorkflowRuntime } from "@/modules/tasks/server";
import { requireIdentityActor } from "@/modules/identity/web";
import { createApiError,handleApiRequest } from "@/modules/shared/public";
import { detailData,mapTaskError } from "../handler.ts";
export const runtime="nodejs";export const dynamic="force-dynamic";type Context={readonly params:Promise<{readonly taskId:string}>};
export function GET(request:Request,context:Context):Promise<Response>{return handleApiRequest(request,async()=>{try{const{taskId}=await context.params;const result=await getTaskWorkflowRuntime().service.detail(await requireIdentityActor(),taskId);
  if(!result)throw createApiError("NOT_FOUND");return detailData(result);}catch(error){throw mapTaskError(error);}});}
