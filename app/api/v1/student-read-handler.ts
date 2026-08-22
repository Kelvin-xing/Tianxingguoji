import { isStudentReadError } from "../../../modules/crm/server.ts";
import { createApiError } from "../../../modules/shared/public.ts";

export function mapStudentReadError(
  error: unknown,
  endpoint: "list" | "detail",
): unknown {
  if (isStudentReadError(error, "STUDENT_READ_FORBIDDEN")) return createApiError("FORBIDDEN");
  if (endpoint === "detail" && isStudentReadError(error, "STUDENT_ID_INVALID")) {
    return createApiError("NOT_FOUND");
  }
  return error;
}
