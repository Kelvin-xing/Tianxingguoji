import {
  createPlatformBillingOverviewGetHandler,
  PlatformBillingOverviewRuntimeUnavailable,
} from "./handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const defaultGet = createPlatformBillingOverviewGetHandler({
  authenticatePlatformOperator: async () => {
    throw new PlatformBillingOverviewRuntimeUnavailable();
  },
  getOverviewReader: () => {
    throw new PlatformBillingOverviewRuntimeUnavailable();
  },
});

export async function GET(request: Request): Promise<Response> {
  return defaultGet(request);
}
