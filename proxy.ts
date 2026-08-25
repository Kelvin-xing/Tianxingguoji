import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const EXCLUDED_PAGE_PATHS = [
  /^\/platform\/billing$/,
  /^\/cases\/reconstructions\/new$/,
  /^\/cases\/reconstructions\/[^/]+$/,
  /^\/students\/duplicates$/,
  /^\/students\/duplicates\/[^/]+$/,
];

export function proxy(request: NextRequest): NextResponse | undefined {
  if (
    request.method !== "GET" ||
    !EXCLUDED_PAGE_PATHS.some((pattern) => pattern.test(request.nextUrl.pathname))
  ) {
    return undefined;
  }

  const requestId = crypto.randomUUID();
  return new NextResponse(
    '<!doctype html><html lang="zh-TW"><head><title>Not Found</title></head><body><h1>Not Found</h1></body></html>',
    {
      status: 404,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
        "x-request-id": requestId,
      },
    },
  );
}

export const config = {
  matcher: [
    "/platform/billing",
    "/cases/reconstructions/:path*",
    "/students/duplicates/:path*",
  ],
};
