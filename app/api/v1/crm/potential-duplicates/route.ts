import {
  getPotentialDuplicateRuntime,
  PotentialDuplicateError,
} from "@/modules/crm/potential-duplicates-server";
import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import { createApiError, handleApiRequest } from "@/modules/shared/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    return handleApiRequest(request, async () => {
    if (!request.headers.get("content-type")?.startsWith("application/json")) throw createApiError("INVALID_REQUEST");
    let body: Record<string, unknown>;
    try { body = await request.json() as Record<string, unknown>; } catch { throw createApiError("INVALID_REQUEST"); }
    const allowed=["kind","name","email","phone"];
    if (typeof body !== "object" || body === null || Object.keys(body).some((k)=>!allowed.includes(k))) throw createApiError("INVALID_REQUEST");
    if (body.kind !== "student" && body.kind !== "guardian") throw createApiError("VALIDATION_FAILED");
    const nullable = (v: unknown) => v === null || typeof v === "string";
    if ((body.name !== undefined && typeof body.name !== "string") || !nullable(body.email ?? null) || !nullable(body.phone ?? null)) throw createApiError("VALIDATION_FAILED");
    const actor = await requireApiRequestAccessContext();
    try {
      const result = await getPotentialDuplicateRuntime().service.check({ actor, kind: body.kind, name: (body.name as string|undefined) ?? "", email: body.email as string|null ?? null, phone: body.phone as string|null ?? null });
      return { warnings: result.warnings.map((w) => ({ id:w.id, matching_fields:w.matchingFields, display_name_hint:w.displayNameHint, email_hint:w.emailHint, phone_hint:w.phoneHint })), warning_token: result.warningToken };
    } catch (error) {
      if (error instanceof PotentialDuplicateError) {
        if (error.code === "POTENTIAL_DUPLICATE_FORBIDDEN") throw createApiError("FORBIDDEN");
        if (error.code === "POTENTIAL_DUPLICATE_INVALID") throw createApiError("VALIDATION_FAILED");
        throw createApiError("SERVICE_UNAVAILABLE");
      }
      throw error;
    }
  });
}

export async function GET(request: Request) { return handleApiRequest(request, async () => { throw createApiError("NOT_FOUND"); }); }
