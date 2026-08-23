import { getTaskWorkflowRuntime } from "@/modules/tasks/server";
import { requireIdentityActor } from "@/modules/identity/web";
import { createApiError,handleApiRequest } from "@/modules/shared/public";
import { mapTaskError,optionsData,parseTaskOptionsQuery } from "../handler.ts";
export const runtime="nodejs";export const dynamic="force-dynamic";
export function GET(request:Request):Promise<Response>{return handleApiRequest(request,async()=>{try{const result=await getTaskWorkflowRuntime().service.options(await requireIdentityActor(),parseTaskOptionsQuery(request));
  if(!result)throw createApiError("NOT_FOUND");return optionsData(result);}catch(error){throw mapTaskError(error);}});}
