import {getGuardianRelationshipRuntime} from '@/modules/crm/server';
import {requireApiRequestAccessContext} from '@/app/api/v1/request-access';
import {createRequestContext,errorResponse,successResponse} from '@/modules/shared/public';
import {parseNewGuardianCommand,mapGuardianRelationshipError,toRelationshipData} from '../handler.ts';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function POST(request:Request,context:{params:Promise<{studentId:string}>}){
  const requestContext=createRequestContext(request);
  try{
    const {studentId}=await context.params;
    const command=await parseNewGuardianCommand(request,studentId,requestContext.requestId);
    const actor=await requireApiRequestAccessContext();
    const result=await getGuardianRelationshipRuntime().service.createAndAttachGuardian({actor,command});
    return successResponse(requestContext,{relationship:toRelationshipData(result)},201);
  }catch(error){return errorResponse(requestContext,mapGuardianRelationshipError(error));}
}
