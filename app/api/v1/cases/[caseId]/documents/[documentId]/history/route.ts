import { requireDocumentActor,getDocumentVersionRuntime,type DocumentVersionError } from '@/modules/documents/server';
import { createApiError,handleApiRequest } from '@/modules/shared/public';
import { assertNoDocumentQuery } from '../../../../../documents/handler.ts';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request,context:{readonly params:Promise<{caseId:string;documentId:string}>}):Promise<Response>{
  return handleApiRequest(request,async()=>{
    assertNoDocumentQuery(request);
    const actor=await requireDocumentActor();
    const {caseId,documentId}=await context.params;
    if(![caseId,documentId].every(id=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)))throw createApiError('INVALID_REQUEST');
    try{return await getDocumentVersionRuntime().history({actor,organizationId:actor.organizationId,caseId,documentId});}
    catch(error){
      if(error instanceof Error&&error.name==='DocumentVersionError'&&['DOCUMENT_VERSION_NOT_FOUND','DOCUMENT_VERSION_CASE_FORBIDDEN'].includes((error as DocumentVersionError).code))throw createApiError('NOT_FOUND');
      throw createApiError('SERVICE_UNAVAILABLE');
    }
  });
}
