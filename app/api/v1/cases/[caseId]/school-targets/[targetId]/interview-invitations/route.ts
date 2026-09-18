import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import { getInterviewInvitationService, type InterviewInvitationError } from "@/modules/cases/server";
import { getTaskWorkflowRuntime } from "@/modules/tasks/server";
import { createApiError, handleApiRequest } from "@/modules/shared/public";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(request:Request,context:{readonly params:Promise<{caseId:string;targetId:string}>}):Promise<Response> {
  return handleApiRequest(request,async requestContext=>{
    try {
      const actor=await requireApiRequestAccessContext();
      if(request.headers.get("content-type")?.split(";",1)[0]!=="application/json")throw createApiError("INVALID_REQUEST");
      let body:unknown;try{body=await request.json();}catch{throw createApiError("INVALID_REQUEST");}
      if(!body||typeof body!=="object"||Array.isArray(body))throw createApiError("VALIDATION_FAILED");
      const data=body as Record<string,unknown>;
      if(Object.keys(data).sort().join(",")!=="expected_record_version,interview_at,invitation_document_id"||
        typeof data.expected_record_version!=="number"||typeof data.interview_at!=="string"||typeof data.invitation_document_id!=="string")throw createApiError("VALIDATION_FAILED");
      const key=request.headers.get("idempotency-key")?.trim();if(!key)throw createApiError("INVALID_REQUEST");
      const {caseId,targetId}=await context.params;
      const result=await getInterviewInvitationService().record({actor,caseId,targetId,expectedRecordVersion:data.expected_record_version,
        interviewAt:data.interview_at,invitationDocumentId:data.invitation_document_id,requestId:requestContext.requestId,idempotencyKey:key});
      const completed=await getTaskWorkflowRuntime().interviewTaskConsumer.drainForInvitation({organizationId:actor.organizationId,
        caseId,targetId,invitationId:result.invitationId,requestId:requestContext.requestId});
      return {target_id:result.targetId,record_version:result.recordVersion,state:result.state,invitation_id:result.invitationId,
        automation:{interview_task:completed?"completed":"pending"}};
    }catch(error){
      if(!(error instanceof Error)||error.name!=="InterviewInvitationError")throw error;
      const code=(error as InterviewInvitationError).code;
      switch(code){
        case "INVALID":case "EVIDENCE_REQUIRED":throw createApiError("VALIDATION_FAILED");
        case "NOT_FOUND":throw createApiError("NOT_FOUND");
        case "FORBIDDEN":throw createApiError("FORBIDDEN");
        case "CONFLICT":throw createApiError("CONFLICT");
        case "STALE_VERSION":throw createApiError("STALE_VERSION");
        case "UNAVAILABLE":throw createApiError("SERVICE_UNAVAILABLE");
        default:throw error;
      }
    }
  });
}
