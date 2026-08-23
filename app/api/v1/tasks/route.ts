import { getTaskWorkflowRuntime } from "@/modules/tasks/server";
import { requireIdentityActor } from "@/modules/identity/web";
import { createRequestContext,errorResponse,handleApiRequest,successResponse } from "@/modules/shared/public";
import { acknowledgementData,collectionData,mapTaskError,parseTaskCreate,parseTaskListQuery } from "./handler.ts";
export const runtime="nodejs";export const dynamic="force-dynamic";
export function GET(request:Request):Promise<Response>{return handleApiRequest(request,async()=>{try{return collectionData(await getTaskWorkflowRuntime().service.list(await requireIdentityActor(),parseTaskListQuery(request)));}catch(error){throw mapTaskError(error);}});}
export async function POST(request:Request):Promise<Response>{const context=createRequestContext(request);try{const result=await getTaskWorkflowRuntime().service.create({actor:await requireIdentityActor(),command:await parseTaskCreate(request,context.requestId)});
  return successResponse(context,acknowledgementData(result),201);}catch(error){return errorResponse(context,mapTaskError(error));}}
