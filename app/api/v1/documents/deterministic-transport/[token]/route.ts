import { handleDeterministicDocumentTransportRequest } from "../../../../../../modules/documents/server.ts";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Context = Readonly<{ params: Promise<Readonly<{ token: string }>> }>;

export async function PUT(request: Request, context: Context): Promise<Response> {
  return handleDeterministicDocumentTransportRequest(request, (await context.params).token);
}

export async function GET(request: Request, context: Context): Promise<Response> {
  return handleDeterministicDocumentTransportRequest(request, (await context.params).token);
}
