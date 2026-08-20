import "server-only";

import type { PortalRuntime } from "../../external-portal/server.ts";
import type { PlatformBillingRuntime } from "./runtime.ts";
import type { PlatformBillingActor } from "../domain/policy.ts";

const HK_REGION = "ap-east-1" as const;
const HK_RDS_HOST = /^[a-z0-9][a-z0-9.-]*\.ap-east-1\.rds\.amazonaws\.com$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANONICAL_DATABASE_ROLE = "tianxing_app" as const;

type Environment = Readonly<Record<string, string | undefined>>;
export interface ProductionDatabaseIdentity {
  readonly host: string;
  readonly port: 5432;
  readonly database: "tianxing";
  readonly user: typeof CANONICAL_DATABASE_ROLE;
  readonly ssl: Readonly<{ rejectUnauthorized: true }>;
}

export interface PortalBillingProductionConfig {
  readonly region: typeof HK_REGION;
  readonly database: ProductionDatabaseIdentity;
  readonly portalDiscovery: ProductionDatabaseIdentity;
  readonly portalTenant: ProductionDatabaseIdentity;
  readonly platformBilling: ProductionDatabaseIdentity;
  readonly platformBillingReader: ProductionDatabaseIdentity;
}

export class PortalBillingProductionConfigurationError extends Error {
  readonly code = "PORTAL_BILLING_PRODUCTION_CONFIG_INVALID" as const;
  readonly variable: string;

  constructor(variable: string) {
    super(`Missing or invalid Portal/Billing production configuration: ${variable}.`);
    this.name = "PortalBillingProductionConfigurationError";
    this.variable = variable;
  }
}

export type PortalBillingCompositionBlocker =
  | "PORTAL_DISCOVERY_RDS_ADAPTER_FACTORY_REQUIRED"
  | "PORTAL_TENANT_RDS_ADAPTER_FACTORY_REQUIRED"
  | "PLATFORM_OPERATOR_AUTH_FACTORY_REQUIRED"
  | "PLATFORM_BILLING_RDS_ADAPTER_FACTORY_REQUIRED"
  | "PLATFORM_BILLING_AGGREGATE_READER_FACTORY_REQUIRED";

export class PortalBillingCompositionUnavailable extends Error {
  readonly code = "PORTAL_BILLING_COMPOSITION_UNAVAILABLE" as const;
  readonly blockers: readonly PortalBillingCompositionBlocker[];

  constructor(blockers: readonly PortalBillingCompositionBlocker[]) {
    super("Portal/Billing production composition prerequisites are unavailable.");
    this.name = "PortalBillingCompositionUnavailable";
    this.blockers = Object.freeze([...blockers]);
  }
}

export interface PlatformOperatorAuthenticator {
  authenticate(): Promise<PlatformBillingActor | null>;
}

export interface PortalDiscoveryLocator {
  readonly organizationId: string;
  readonly grantId: string;
  readonly serviceCaseId: string;
}

export interface PortalDiscoveryAdapter {
  /** Calls only portal_discover_grant_by_keyed_hash(bytea); it does not authorize access. */
  discoverByKeyedSecretHash(
    keyedSecretHash: string,
  ): Promise<PortalDiscoveryLocator | null>;
}

export interface PortalTenantRuntimeResolver {
  /** Opens the later tianxing_app tenant transaction for full request-time authorization. */
  resolve(locator: PortalDiscoveryLocator): Promise<PortalRuntime>;
}

export interface PlatformBillingAggregateReader {
  readOverview(): Promise<unknown>;
}

export interface PortalBillingProductionFactories {
  readonly portalDiscovery?: {
    create(input: Readonly<{
      database: ProductionDatabaseIdentity;
    }>): PortalDiscoveryAdapter;
  };
  readonly portalTenant?: {
    create(input: Readonly<{
      database: ProductionDatabaseIdentity;
    }>): PortalTenantRuntimeResolver;
  };
  readonly platformOperatorAuth?: {
    /** Must verify a PlatformOperator identity independently of organization membership. */
    create(): PlatformOperatorAuthenticator;
  };
  readonly platformBilling?: {
    create(input: Readonly<{
      database: ProductionDatabaseIdentity;
    }>): PlatformBillingRuntime;
  };
  readonly platformBillingOverview?: {
    create(input: Readonly<{
      database: ProductionDatabaseIdentity;
    }>): PlatformBillingAggregateReader;
  };
}

export interface PortalBillingProductionComposition {
  /** Discovery always precedes tenant resolution; a miss never opens the tenant adapter. */
  resolvePortalRuntime(keyedSecretHash: string): Promise<PortalRuntime | null>;
  readonly platformOperatorAuth: PlatformOperatorAuthenticator;
  readonly platformBilling: PlatformBillingRuntime;
  readonly platformBillingOverview: PlatformBillingAggregateReader;
}

export function loadPortalBillingProductionConfig(
  environment: Environment = process.env,
): PortalBillingProductionConfig {
  if (required(environment, "AWS_REGION") !== HK_REGION) {
    throw new PortalBillingProductionConfigurationError("AWS_REGION");
  }

  const database = loadDatabase(environment);
  return Object.freeze({
    region: HK_REGION,
    database,
    portalDiscovery: database,
    portalTenant: database,
    platformBilling: database,
    platformBillingReader: database,
  });
}

export function composePortalBillingProductionRuntime(
  environment: Environment,
  factories: PortalBillingProductionFactories,
): PortalBillingProductionComposition {
  const config = loadPortalBillingProductionConfig(environment);
  const blockers: PortalBillingCompositionBlocker[] = [];
  if (!factories.portalDiscovery) {
    blockers.push("PORTAL_DISCOVERY_RDS_ADAPTER_FACTORY_REQUIRED");
  }
  if (!factories.portalTenant) {
    blockers.push("PORTAL_TENANT_RDS_ADAPTER_FACTORY_REQUIRED");
  }
  if (!factories.platformOperatorAuth) blockers.push("PLATFORM_OPERATOR_AUTH_FACTORY_REQUIRED");
  if (!factories.platformBilling) blockers.push("PLATFORM_BILLING_RDS_ADAPTER_FACTORY_REQUIRED");
  if (!factories.platformBillingOverview) {
    blockers.push("PLATFORM_BILLING_AGGREGATE_READER_FACTORY_REQUIRED");
  }
  if (blockers.length > 0) throw new PortalBillingCompositionUnavailable(blockers);

  const portalDiscoveryFactory = factories.portalDiscovery!;
  const portalTenantFactory = factories.portalTenant!;
  const authFactory = factories.platformOperatorAuth!;
  const billingFactory = factories.platformBilling!;
  const overviewFactory = factories.platformBillingOverview!;

  const portalDiscovery = portalDiscoveryFactory.create(Object.freeze({
    database: config.portalDiscovery,
  }));
  const portalTenant = portalTenantFactory.create(Object.freeze({
    database: config.portalTenant,
  }));

  return Object.freeze({
    async resolvePortalRuntime(keyedSecretHash: string): Promise<PortalRuntime | null> {
      if (!/^[0-9a-f]{64}$/.test(keyedSecretHash)) {
        throw new PortalBillingProductionConfigurationError("PORTAL_KEYED_SECRET_HASH");
      }
      const locator = await portalDiscovery.discoverByKeyedSecretHash(keyedSecretHash);
      if (locator === null) return null;
      if (
        !UUID.test(locator.organizationId) ||
        !UUID.test(locator.grantId) ||
        !UUID.test(locator.serviceCaseId)
      ) {
        throw new PortalBillingProductionConfigurationError("PORTAL_DISCOVERY_LOCATOR");
      }
      return portalTenant.resolve(locator);
    },
    platformOperatorAuth: authFactory.create(),
    platformBilling: billingFactory.create(Object.freeze({ database: config.platformBilling })),
    platformBillingOverview: overviewFactory.create(Object.freeze({
      database: config.platformBillingReader,
    })),
  });
}

function loadDatabase(environment: Environment): ProductionDatabaseIdentity {
  const raw = required(environment, "DATABASE_URL");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new PortalBillingProductionConfigurationError("DATABASE_URL");
  }
  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "postgresql:" ||
    !HK_RDS_HOST.test(host) ||
    parsed.username !== CANONICAL_DATABASE_ROLE ||
    parsed.password.length === 0 ||
    parsed.pathname !== "/tianxing" ||
    parsed.port !== "5432" ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new PortalBillingProductionConfigurationError("DATABASE_URL");
  }
  rejectLegacyDatabaseVariables(environment);
  return Object.freeze({
    host,
    port: 5432,
    database: "tianxing",
    user: CANONICAL_DATABASE_ROLE,
    ssl: Object.freeze({ rejectUnauthorized: true }),
  });
}

function rejectLegacyDatabaseVariables(environment: Environment): void {
  for (const variable of [
    "PORTAL_AUTH_DATABASE_HOST",
    "PORTAL_AUTH_DATABASE_NAME",
    "PORTAL_AUTH_DATABASE_PORT",
    "PORTAL_AUTH_DATABASE_USER",
    "PORTAL_TENANT_DATABASE_HOST",
    "PORTAL_TENANT_DATABASE_NAME",
    "PORTAL_TENANT_DATABASE_PORT",
    "PORTAL_TENANT_DATABASE_USER",
    "PLATFORM_BILLING_DATABASE_HOST",
    "PLATFORM_BILLING_DATABASE_NAME",
    "PLATFORM_BILLING_DATABASE_PORT",
    "PLATFORM_BILLING_DATABASE_USER",
    "PLATFORM_BILLING_READER_DATABASE_HOST",
    "PLATFORM_BILLING_READER_DATABASE_NAME",
    "PLATFORM_BILLING_READER_DATABASE_PORT",
    "PLATFORM_BILLING_READER_DATABASE_USER",
  ]) {
    if (environment[variable]?.trim()) {
      throw new PortalBillingProductionConfigurationError(variable);
    }
  }
}

function required(environment: Environment, variable: string): string {
  const value = environment[variable]?.trim();
  if (!value || /[\r\n]/.test(value)) {
    throw new PortalBillingProductionConfigurationError(variable);
  }
  return value;
}
