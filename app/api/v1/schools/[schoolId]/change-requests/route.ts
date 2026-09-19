import {requireApiRequestAccessContext} from '@/app/api/v1/request-access';
import {getApplicationTenantRunner} from '@/modules/shared/server';
import {SchoolResolutionError,SchoolServiceError,submitSchoolChange,PostgresqlSchoolChangeRepository,type SubmitSchoolChangeCommand} from '@/modules/schools/server';
import {createApiError,handleApiRequest} from '@/modules/shared/public';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request:Request,context:{readonly params:Promise<{readonly schoolId:string}>}):Promise<Response>{
  return handleApiRequest(request,async()=>{
    const {schoolId}=await context.params;
    if(!UUID.test(schoolId)||new URL(request.url).search)throw createApiError('INVALID_REQUEST');
    const actor=await requireApiRequestAccessContext();
    try{
      const items=await new PostgresqlSchoolChangeRepository(getApplicationTenantRunner()).list({organizationId:actor.organizationId,actorUserId:actor.userId,schoolId});
      return {items:items.map(item=>({...item,fields:item.fields.map(field=>({...field}))}))};
    }catch(error){
      if(error instanceof SchoolResolutionError){
        if(error.code==='SCHOOL_RESOLUTION_FORBIDDEN')throw createApiError('FORBIDDEN');
        if(error.code==='SCHOOL_RESOLUTION_NOT_FOUND')throw createApiError('NOT_FOUND');
      }
      throw createApiError('SERVICE_UNAVAILABLE');
    }
  });
}

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly schoolId: string }> },
): Promise<Response> {
  return handleApiRequest(request, async (requestContext) => {
    const { schoolId } = await context.params;
    if (!UUID.test(schoolId)) throw createApiError("INVALID_REQUEST");
    const command = await parseChangeCommand(request, requestContext.requestId);
    const actor=await requireApiRequestAccessContext();
    try {
      const result=await submitSchoolChange({actor,schoolId,command},{repository:new PostgresqlSchoolChangeRepository(getApplicationTenantRunner())});
      return {
        change_request_id: result.changeRequestId,
        school_id: result.schoolId,
        base_snapshot_id: result.baseSnapshotId,
        field_name: result.fieldName,
        status: result.status,
        record_version: result.recordVersion,
      };
    } catch (error) {
      throw mapSchoolError(error);
    }
  });
}

async function parseChangeCommand(
  request: Request,
  requestId: string,
): Promise<SubmitSchoolChangeCommand> {
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
    throw createApiError("INVALID_REQUEST");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw createApiError("INVALID_REQUEST");
  }
  if (!isRecord(body) || !isRecord(body.evidence)) throw createApiError("INVALID_REQUEST");

  const allowed=['field_name','field_class','base_snapshot_id','base_value_sha256','proposed_value','reason','evidence'];
  if(Object.keys(body).some(key=>!allowed.includes(key))||Object.keys(body.evidence).some(key=>!['source_url','quote'].includes(key)))throw createApiError('INVALID_REQUEST');
  const fieldName = body.field_name;
  const fieldClass = body.field_class;
  const baseSnapshotId = body.base_snapshot_id;
  const baseValueSha256 = body.base_value_sha256;
  const proposedValue = body.proposed_value;
  const reason = body.reason;
  const sourceUrl = body.evidence.source_url;
  const quote = body.evidence.quote;
  if (
    typeof fieldName !== "string" ||
    typeof fieldClass !== "string" ||
    typeof baseSnapshotId !== "string" ||
    typeof baseValueSha256 !== "string" ||
    typeof reason !== "string" ||
    typeof sourceUrl !== "string" ||
    typeof quote !== "string"
  ) {
    throw createApiError("VALIDATION_FAILED");
  }

  return {
    fieldName,
    fieldClass: fieldClass as SubmitSchoolChangeCommand["fieldClass"],
    baseSnapshotId,
    baseValueSha256,
    proposedValue,
    reason,
    evidence: { sourceUrl, quote },
    requestId,
    idempotencyKey,
  };
}

function mapSchoolError(error: unknown) {
  if (!(error instanceof SchoolServiceError)) return createApiError("SERVICE_UNAVAILABLE");

  switch (error.code) {
    case "SCHOOL_ADVISOR_REQUIRED":
      return createApiError("FORBIDDEN");
    case "SCHOOL_COMMAND_INVALID":
      return createApiError("VALIDATION_FAILED");
    case "SCHOOL_CHANGE_BASE_NOT_FOUND":
      return createApiError("NOT_FOUND");
    case "SCHOOL_CHANGE_BASE_STALE":
    case "SCHOOL_CHANGE_IDEMPOTENCY_KEY_REUSED":
    case "SCHOOL_CHANGE_IDEMPOTENCY_IN_PROGRESS":
      return createApiError("CONFLICT");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
