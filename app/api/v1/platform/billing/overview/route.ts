import type {
  PlatformBillingActor,
  PlatformBillingRole,
} from "@/modules/platform-billing/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = Object.freeze({
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
});

const VIEW_ROLES: readonly PlatformBillingRole[] = Object.freeze([
  "platform_admin",
  "platform_finance",
  "platform_billing_approver",
]);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface PlatformBillingOverviewOrganization {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly lifecycleStatus: "active" | "inactive";
  readonly subscription: {
    readonly status: "active" | "past_due";
    readonly aggregateException: "past_due" | null;
  };
  readonly advancingCaseSnapshot: {
    readonly billingMonth: string;
    readonly sourceCutoffAt: string;
    readonly countPolicyVersion: "advancing_case_count_v1";
    readonly advancingCaseCount: number;
    readonly revision: number;
    readonly generatedAt: string;
  } | null;
  readonly contract: {
    readonly reference: string;
    readonly status: "draft" | "active" | "superseded";
  } | null;
}

export interface PlatformBillingOverview {
  readonly generatedAt: string;
  readonly organizations: readonly PlatformBillingOverviewOrganization[];
}

export interface PlatformBillingOverviewReader {
  readOverview(): Promise<PlatformBillingOverview>;
}

export class PlatformBillingOverviewRuntimeUnavailable extends Error {
  readonly code = "BILLING_RUNTIME_UNAVAILABLE" as const;

  constructor() {
    super("PlatformBilling overview runtime is not configured.");
    this.name = "PlatformBillingOverviewRuntimeUnavailable";
  }
}

export interface PlatformBillingOverviewDependencies {
  authenticatePlatformOperator(): Promise<PlatformBillingActor | null>;
  getOverviewReader(): PlatformBillingOverviewReader;
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE_HEADERS });
}

function error(code: string, status: number): Response {
  return json({ error: { code } }, status);
}

function isApprovedActor(actor: PlatformBillingActor): boolean {
  return (
    UUID_PATTERN.test(actor.actorId) &&
    actor.status === "active" &&
    VIEW_ROLES.includes(actor.role)
  );
}

function sanitizeOverview(value: PlatformBillingOverview): PlatformBillingOverview {
  return {
    generatedAt: value.generatedAt,
    organizations: value.organizations.map((organization) => ({
      organizationId: organization.organizationId,
      organizationName: organization.organizationName,
      lifecycleStatus: organization.lifecycleStatus,
      subscription: {
        status: organization.subscription.status,
        aggregateException: organization.subscription.aggregateException,
      },
      advancingCaseSnapshot: organization.advancingCaseSnapshot === null
        ? null
        : {
            billingMonth: organization.advancingCaseSnapshot.billingMonth,
            sourceCutoffAt: organization.advancingCaseSnapshot.sourceCutoffAt,
            countPolicyVersion: organization.advancingCaseSnapshot.countPolicyVersion,
            advancingCaseCount: organization.advancingCaseSnapshot.advancingCaseCount,
            revision: organization.advancingCaseSnapshot.revision,
            generatedAt: organization.advancingCaseSnapshot.generatedAt,
          },
      contract: organization.contract === null
        ? null
        : {
            reference: organization.contract.reference,
            status: organization.contract.status,
          },
    })),
  };
}

export function createPlatformBillingOverviewGetHandler(
  dependencies: PlatformBillingOverviewDependencies,
): (request: Request) => Promise<Response> {
  return async function getPlatformBillingOverview(_request: Request): Promise<Response> {
    try {
      const actor = await dependencies.authenticatePlatformOperator();
      if (actor === null) return error("PLATFORM_AUTHENTICATION_REQUIRED", 401);
      if (!isApprovedActor(actor)) {
        return error("PLATFORM_BILLING_OVERVIEW_FORBIDDEN", 403);
      }

      const overview = await dependencies.getOverviewReader().readOverview();
      return json(sanitizeOverview(overview), 200);
    } catch (caught) {
      if (caught instanceof PlatformBillingOverviewRuntimeUnavailable) {
        return error(caught.code, 503);
      }
      return error("PLATFORM_BILLING_OVERVIEW_FAILED", 500);
    }
  };
}

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
