import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import { createApiError, handleApiRequest, type JsonValue } from "@/modules/shared/public";
import { getP3TaskReadRuntime, P3TaskReadError } from "@/modules/tasks/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleApiRequest(request, async () => {
    try {
      if ([...new URL(request.url).searchParams.keys()].length > 0) {
        throw createApiError("VALIDATION_FAILED");
      }
      const items = await getP3TaskReadRuntime().service.listAssigned(
        await requireApiRequestAccessContext(),
      );
      return { items: items as unknown as JsonValue };
    } catch (error) {
      throw mapReadError(error);
    }
  });
}

function mapReadError(error: unknown): unknown {
  if (!(error instanceof P3TaskReadError)) return error;
  if (error.code === "INVALID") throw createApiError("VALIDATION_FAILED");
  if (error.code === "FORBIDDEN") throw createApiError("FORBIDDEN");
  throw createApiError("SERVICE_UNAVAILABLE");
}
