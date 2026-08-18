export const DATABASE_TEST_LOGIN_BODY_MAX_BYTES = 4 * 1024;

export class DatabaseTestLoginRequestError extends Error {
  constructor() {
    super("Database test login request is invalid.");
    this.name = "DatabaseTestLoginRequestError";
  }
}

export async function readDatabaseTestLoginRequest(
  request: Request,
): Promise<Readonly<{ email: string; password: string }>> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  const [mediaType, ...parameters] = contentType.split(";").map((value) => value.trim());
  if (
    mediaType !== "application/x-www-form-urlencoded" ||
    parameters.some((value) => value !== "charset=utf-8")
  ) {
    throw new DatabaseTestLoginRequestError();
  }

  const bytes = await readBoundedBody(request);
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DatabaseTestLoginRequestError();
  }
  if (/%(?![0-9a-f]{2})/i.test(body)) throw new DatabaseTestLoginRequestError();
  const fields = new URLSearchParams(body);
  const keys = [...fields.keys()];
  if (
    keys.length !== 2 ||
    keys.filter((key) => key === "email").length !== 1 ||
    keys.filter((key) => key === "password").length !== 1
  ) {
    throw new DatabaseTestLoginRequestError();
  }
  return Object.freeze({ email: fields.get("email") ?? "", password: fields.get("password") ?? "" });
}

async function readBoundedBody(request: Request): Promise<Uint8Array> {
  if (!request.body) throw new DatabaseTestLoginRequestError();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > DATABASE_TEST_LOGIN_BODY_MAX_BYTES) {
        throw new DatabaseTestLoginRequestError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}
