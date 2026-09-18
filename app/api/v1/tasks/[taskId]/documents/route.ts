import { getDocumentWorkspaceRuntime,DocumentWorkspaceError,type TaskDocumentAction } from "@/modules/documents/server";
import { requireIdentityActor } from "@/modules/identity/web";
import { createRequestContext,errorResponse,successResponse } from "@/modules/shared/public";
import { mapDocumentWorkspaceError } from "../../../documents/handler.ts";
export const runtime="nodejs";
export const dynamic="force-dynamic";
type Context={readonly params:Promise<{readonly taskId:string}>};
function invalid():never {throw new DocumentWorkspaceError("DOCUMENT_WORKSPACE_INVALID");}
export async function GET(request:Request,context:Context) {
  const requestContext=createRequestContext(request);
  try {
    if(new URL(request.url).searchParams.size) invalid();
    const result=await getDocumentWorkspaceRuntime().taskLinks.list(await requireIdentityActor(),(await context.params).taskId);
    return successResponse(requestContext,{can_manage:result.canManage,can_grant:result.canGrant,document_options:result.options.map(option=>({id:option.id,display_name:option.displayName})),links:result.links.map(link=>({id:link.id,document_id:link.documentId,
      display_name:link.displayName,record_version:link.recordVersion,allowed_actions:[...link.allowedActions],available_version:link.availableVersion,...(link.configuredActions?{configured_actions:[...link.configuredActions]}:{})}))});
  } catch(e){return errorResponse(requestContext,mapDocumentWorkspaceError(e));}
}
export async function POST(request:Request,context:Context) {
  const requestContext=createRequestContext(request);
  try {
    if(new URL(request.url).searchParams.size || request.headers.get('content-type')?.split(';')[0]?.trim()!=='application/json') invalid();
    let body:unknown;try {body=await request.json();} catch {invalid();}
    if(!body || typeof body!=='object' || Array.isArray(body)) invalid();
    const value=body as Record<string,unknown>;
    if(Object.keys(value).sort().join(',')!=='allowed_actions,document_id,expected_record_version,reason'
      || typeof value.document_id!=='string' || typeof value.expected_record_version!=='number'
      || typeof value.reason!=='string' || !Array.isArray(value.allowed_actions)) invalid();
    const key=request.headers.get('idempotency-key');if(!key) invalid();
    const result=await getDocumentWorkspaceRuntime().taskLinks.set({actor:await requireIdentityActor(),taskId:(await context.params).taskId,
      documentId:value.document_id,expectedRecordVersion:value.expected_record_version,reason:value.reason,
      allowedActions:value.allowed_actions as TaskDocumentAction[],requestId:requestContext.requestId,idempotencyKey:key});
    return successResponse(requestContext,{id:result.id,record_version:result.recordVersion});
  } catch(e){return errorResponse(requestContext,mapDocumentWorkspaceError(e));}
}
