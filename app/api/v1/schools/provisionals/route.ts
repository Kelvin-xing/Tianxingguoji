import {requireApiRequestAccessContext} from '@/app/api/v1/request-access';
import {hasRequestCapability} from '@/modules/access/public';
import {getApplicationTenantRunner} from '@/modules/shared/server';
import {SchoolServiceError,SchoolResolutionError,PostgresqlSchoolDirectoryRepository,createProvisionalSchool,PostgresqlProvisionalSchoolRepository,type CreateProvisionalSchoolCommand} from '@/modules/schools/server';
import {createApiError,handleApiRequest} from '@/modules/shared/public';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request:Request):Promise<Response>{
  return handleApiRequest(request,async()=>{
    const actor=await requireApiRequestAccessContext();
    if(!hasRequestCapability(actor,'schools.read'))throw createApiError('FORBIDDEN');
    try{
      const items=await new PostgresqlSchoolDirectoryRepository(getApplicationTenantRunner()).listProvisionals({organizationId:actor.organizationId,actorUserId:actor.userId});
      return {items};
    }catch(error){
      if(error instanceof SchoolResolutionError&&error.code==='SCHOOL_RESOLUTION_FORBIDDEN')throw createApiError('FORBIDDEN');
      throw createApiError('SERVICE_UNAVAILABLE');
    }
  });
}

export async function POST(request: Request): Promise<Response> {
  return handleApiRequest(request, async (requestContext) => {
    const command = await parseProvisionalCommand(request, requestContext.requestId);
    const actor = await requireApiRequestAccessContext();
    if (!hasRequestCapability(actor,'schools.provisional.create')) throw createApiError('FORBIDDEN');
    try {
      const result = await createProvisionalSchool({actor,command},{repository:new PostgresqlProvisionalSchoolRepository(getApplicationTenantRunner())});
      return {
        school_id: result.schoolId,
        status: result.status,
        record_version: result.recordVersion,
      };
    } catch (error) {
      throw mapSchoolError(error);
    }
  });
}

async function parseProvisionalCommand(
  request: Request,
  requestId: string,
): Promise<CreateProvisionalSchoolCommand> {
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
  if (!isRecord(body)) throw createApiError("INVALID_REQUEST");

  const allowed=['school_name_zh','school_name_en','district','system','stage','reason'];
  if(Object.keys(body).some(key=>!allowed.includes(key)))throw createApiError('INVALID_REQUEST');
  for(const value of Object.values(body))if(value!==null&&typeof value!=='string')throw createApiError('VALIDATION_FAILED');
  return {schoolNameZh:body.school_name_zh as string|null|undefined,schoolNameEn:body.school_name_en as string|null|undefined,
    district:body.district as string|null|undefined,system:body.system as string|null|undefined,
    stage:body.stage as string|null|undefined,reason:body.reason as string|null|undefined,requestId,idempotencyKey};
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
