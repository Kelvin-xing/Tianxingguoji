export const PRODUCTION_REGION = "ap-east-1" as const;
export const PRODUCTION_ADAPTER_KINDS = Object.freeze(["aws-cognito", "aws-rds", "aws-s3", "aws-sqs", "aws-kms", "aws-telemetry"] as const);
export type ProductionAdapterKind = (typeof PRODUCTION_ADAPTER_KINDS)[number];
export type ProductionRuntimeMode = "production-aws" | "cloud-synthetic";
export type ProductionAppEnvironment = "development" | "test" | "production";
export type ProviderErrorCode = "CONFIG_INVALID" | "REGION_UNSUPPORTED" | "ADAPTER_UNSUPPORTED" | "PROVIDER_UNAVAILABLE" | "PROVIDER_REJECTED" | "PRODUCTION_COMPOSITION_UNAVAILABLE" | "SYNTHETIC_PRODUCTION_FORBIDDEN";

export class ProductionBoundaryError extends Error {
  readonly code: ProviderErrorCode;
  constructor(code: ProviderErrorCode) { super(`Production adapter boundary rejected ${code}.`); this.name = "ProductionBoundaryError"; this.code = code; }
}

export interface ProductionAdapterConfig {
  readonly mode: ProductionRuntimeMode;
  readonly appEnvironment: ProductionAppEnvironment;
  readonly region: string;
  readonly adapterKind: ProductionAdapterKind | "synthetic";
  readonly endpoint?: never;
  readonly credentials?: never;
}

export function loadProductionAdapterConfig(environment: Readonly<Record<string, string | undefined>>): Readonly<ProductionAdapterConfig> {
  const mode = environment.APP_RUNTIME_MODE;
  const appEnvironment = environment.APP_ENV;
  const region = environment.AWS_REGION ?? environment.AWS_DEFAULT_REGION;
  const adapterKind = environment.P6_ADAPTER_KIND;
  if (!isMode(mode) || !isEnvironment(appEnvironment) || typeof region !== "string" || typeof adapterKind !== "string") throw new ProductionBoundaryError("CONFIG_INVALID");
  return validateProductionAdapterConfig({ mode, appEnvironment, region, adapterKind: adapterKind as ProductionAdapterConfig["adapterKind"] });
}

export function validateProductionAdapterConfig(input: ProductionAdapterConfig): Readonly<ProductionAdapterConfig> {
  if (!input || typeof input !== "object" || !isMode(input.mode) || !isEnvironment(input.appEnvironment) || typeof input.region !== "string" || typeof input.adapterKind !== "string") throw new ProductionBoundaryError("CONFIG_INVALID");
  if ("endpoint" in input || "credentials" in input) throw new ProductionBoundaryError("CONFIG_INVALID");
  if (input.mode === "production-aws") {
    if (input.appEnvironment !== "production") throw new ProductionBoundaryError("CONFIG_INVALID");
    if (input.region !== PRODUCTION_REGION) throw new ProductionBoundaryError("REGION_UNSUPPORTED");
    if (!PRODUCTION_ADAPTER_KINDS.includes(input.adapterKind as ProductionAdapterKind)) throw new ProductionBoundaryError("ADAPTER_UNSUPPORTED");
  } else {
    if (input.appEnvironment === "production") throw new ProductionBoundaryError("SYNTHETIC_PRODUCTION_FORBIDDEN");
    if (input.adapterKind !== "synthetic") throw new ProductionBoundaryError("ADAPTER_UNSUPPORTED");
  }
  return Object.freeze({ ...input });
}

export interface SyntheticResult<T> { readonly mode: "cloud-synthetic"; readonly simulated: true; readonly value: T; }
export function markCloudSynthetic<T>(value: T): SyntheticResult<T> { return Object.freeze({ mode: "cloud-synthetic", simulated: true, value }); }

export interface ReadinessInput { readonly config: ProductionAdapterConfig; readonly dependencies: readonly string[]; }
export interface MigrationInput { readonly config: ProductionAdapterConfig; readonly migrationId: string; readonly checksum: string; }
export interface RollbackInput { readonly config: ProductionAdapterConfig; readonly migrationId: string; readonly reasonCode: string; }
export function validateReadinessInput(input: ReadinessInput): void { validateProductionAdapterConfig(input.config); if (!Array.isArray(input.dependencies) || input.dependencies.length === 0 || input.dependencies.some((value) => typeof value !== "string" || !/^[a-z][a-z0-9._:-]{0,127}$/.test(value))) throw new ProductionBoundaryError("CONFIG_INVALID"); }
export function validateMigrationInput(input: MigrationInput): void { validateProductionAdapterConfig(input.config); if (!/^[a-z][a-z0-9._:-]{0,127}$/.test(input.migrationId) || !/^[a-f0-9]{64}$/.test(input.checksum)) throw new ProductionBoundaryError("CONFIG_INVALID"); }
export function validateRollbackInput(input: RollbackInput): void { validateProductionAdapterConfig(input.config); if (!/^[a-z][a-z0-9._:-]{0,127}$/.test(input.migrationId) || !/^[a-z][a-z0-9._:-]{0,127}$/.test(input.reasonCode)) throw new ProductionBoundaryError("CONFIG_INVALID"); }
export function toStableProviderError(error: unknown): ProductionBoundaryError { if (error instanceof ProductionBoundaryError) return error; const code = typeof error === "object" && error !== null && "code" in error && (error.code === "PROVIDER_REJECTED" || error.code === "PROVIDER_UNAVAILABLE") ? error.code : "PROVIDER_UNAVAILABLE"; return new ProductionBoundaryError(code); }
function isMode(value: unknown): value is ProductionRuntimeMode { return value === "production-aws" || value === "cloud-synthetic"; }
function isEnvironment(value: unknown): value is ProductionAppEnvironment { return value === "development" || value === "test" || value === "production"; }
