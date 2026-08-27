import { createApiError } from "@/modules/shared/public";

export function parseSchoolOptionsRequest(request: Request): Readonly<{
  query: string | null;
  limit: number;
  cursor: string | null;
}> {
  const parameters = new URL(request.url).searchParams;
  const allowed = new Set(["q","limit","cursor"]);
  if ([...parameters.keys()].some((key) => !allowed.has(key)) ||
      [...allowed].some((key) => parameters.getAll(key).length > 1)) {
    throw createApiError("INVALID_REQUEST");
  }
  const rawQuery = parameters.get("q");
  const query = rawQuery === null ? null : rawQuery.trim().normalize("NFKC");
  const rawLimit = parameters.get("limit");
  const cursor = parameters.get("cursor");
  if ((query !== null && (query.length < 1 || query.length > 100)) ||
      (rawLimit !== null && !/^[1-9][0-9]{0,2}$/.test(rawLimit)) || cursor === "") {
    throw createApiError("INVALID_REQUEST");
  }
  const limit = rawLimit === null ? 25 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw createApiError("INVALID_REQUEST");
  }
  return Object.freeze({ query,limit,cursor });
}
