export type FutureFeatureId =
  | "non_k12_services"
  | "ai_reports"
  | "data_import"
  | "multi_tenant"
  | "subscription"
  | "retention_support";

export type FutureFeatureDisabledErrorCode = "FUTURE_FEATURE_DISABLED";

export interface FutureFeatureContract {
  readonly id: FutureFeatureId;
  readonly decisionIds: readonly string[];
  readonly releaseOneState: "disabled_by_contract";
  readonly permittedSurfaces: readonly ["navigation_placeholder"];
  readonly prohibitedSurfaces: readonly ["route", "job", "credential", "data_write"];
}

export interface ReleaseOneNavigationPlaceholder {
  readonly featureId:
    | "non_k12_services"
    | "ai_reports"
    | "data_import"
    | "multi_tenant";
  readonly label: string;
  readonly statusLabel: "正在開發中";
}

export class FutureFeatureDisabledError extends Error {
  readonly code: FutureFeatureDisabledErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(featureId: FutureFeatureId) {
    super(`Release 1 contract disables ${featureId}`);
    this.name = "FutureFeatureDisabledError";
    this.code = "FUTURE_FEATURE_DISABLED";
    this.details = Object.freeze({
      featureId,
      release: "release_1",
      state: "disabled_by_contract",
    });
  }
}

function defineDisabledFutureFeature(
  id: FutureFeatureId,
  decisionIds: readonly string[],
): FutureFeatureContract {
  return Object.freeze({
    id,
    decisionIds: Object.freeze([...decisionIds]),
    releaseOneState: "disabled_by_contract" as const,
    permittedSurfaces: Object.freeze(["navigation_placeholder"] as const),
    prohibitedSurfaces: Object.freeze(["route", "job", "credential", "data_write"] as const),
  });
}

/**
 * Release 1 records future delivery constraints only. This module deliberately
 * has no executable adapter, runtime configuration, or persistence dependency.
 */
export const FUTURE_FEATURE_CONTRACTS = Object.freeze({
  non_k12_services: defineDisabledFutureFeature("non_k12_services", ["DEC-025"]),
  ai_reports: defineDisabledFutureFeature("ai_reports", ["DEC-047", "DEC-048"]),
  data_import: defineDisabledFutureFeature("data_import", ["DEC-049"]),
  multi_tenant: defineDisabledFutureFeature("multi_tenant", ["DEC-051", "DEC-053", "DEC-060"]),
  subscription: defineDisabledFutureFeature("subscription", ["DEC-053", "DEC-060"]),
  retention_support: defineDisabledFutureFeature("retention_support", ["DEC-054", "DEC-060"]),
} as const satisfies Readonly<Record<FutureFeatureId, FutureFeatureContract>>);

export const RELEASE_ONE_NAVIGATION_PLACEHOLDERS = Object.freeze([
  {
    featureId: "non_k12_services",
    label: "非 K12 服務",
    statusLabel: "正在開發中",
  },
  {
    featureId: "ai_reports",
    label: "AI 報告",
    statusLabel: "正在開發中",
  },
  {
    featureId: "data_import",
    label: "Excel / CSV 匯入",
    statusLabel: "正在開發中",
  },
  {
    featureId: "multi_tenant",
    label: "多組織管理",
    statusLabel: "正在開發中",
  },
] as const satisfies readonly ReleaseOneNavigationPlaceholder[]);

/**
 * Future routes, jobs, providers, and mutations must call this guard until a
 * separate post-Release-1 decision replaces the disabled contract.
 */
export function assertFutureFeatureDisabled(featureId: FutureFeatureId): never {
  throw new FutureFeatureDisabledError(featureId);
}
