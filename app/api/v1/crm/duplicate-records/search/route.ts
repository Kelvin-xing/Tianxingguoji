import { releaseOneExcludedEntryResponse } from "../../../../../../modules/shared/public.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return releaseOneExcludedEntryResponse(request);
}

export async function GET(request: Request): Promise<Response> {
  return releaseOneExcludedEntryResponse(request);
}
