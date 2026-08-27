import {
  markCloudSynthetic,
  ProductionBoundaryError,
  type MigrationInput,
  type ProductionAdapterConfig,
  type ReadinessInput,
  type RollbackInput,
  validateMigrationInput,
  validateProductionAdapterConfig,
  validateReadinessInput,
  validateRollbackInput,
} from "../domain/p6-be-09-production-boundary.ts";

export interface ProductionAdapterComposition {
  readonly mode: ProductionAdapterConfig["mode"];
  readiness(input: ReadinessInput): Promise<Readonly<{ ready: boolean; simulated: boolean }>>;
  migrate(input: MigrationInput): Promise<Readonly<{ applied: boolean; simulated: boolean }>>;
  rollback(input: RollbackInput): Promise<Readonly<{ accepted: boolean; simulated: boolean }>>;
}

export function createProductionAwsComposition(config: ProductionAdapterConfig): ProductionAdapterComposition {
  validateProductionAdapterConfig(config);
  if (config.mode !== "production-aws") throw new ProductionBoundaryError("CONFIG_INVALID");
  return Object.freeze({
    mode: config.mode,
    async readiness(input: ReadinessInput) { validateReadinessInput(input); throw new ProductionBoundaryError("PRODUCTION_COMPOSITION_UNAVAILABLE"); },
    async migrate(input: MigrationInput) { validateMigrationInput(input); throw new ProductionBoundaryError("PRODUCTION_COMPOSITION_UNAVAILABLE"); },
    async rollback(input: RollbackInput) { validateRollbackInput(input); throw new ProductionBoundaryError("PRODUCTION_COMPOSITION_UNAVAILABLE"); },
  });
}

export function createCloudSyntheticComposition(config: ProductionAdapterConfig): ProductionAdapterComposition {
  validateProductionAdapterConfig(config);
  if (config.mode !== "cloud-synthetic") throw new ProductionBoundaryError("CONFIG_INVALID");
  return Object.freeze({
    mode: config.mode,
    async readiness(input: ReadinessInput) { validateReadinessInput(input); return markCloudSynthetic({ ready: true, simulated: true }).value; },
    async migrate(input: MigrationInput) { validateMigrationInput(input); return markCloudSynthetic({ applied: false, simulated: true }).value; },
    async rollback(input: RollbackInput) { validateRollbackInput(input); return markCloudSynthetic({ accepted: false, simulated: true }).value; },
  });
}
