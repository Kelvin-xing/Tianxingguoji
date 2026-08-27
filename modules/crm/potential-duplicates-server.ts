import "server-only";

export {
  getPotentialDuplicateRuntime,
  type PotentialDuplicateRuntime,
} from "./infrastructure/runtime.ts";
export {
  PotentialDuplicateError,
  type PotentialDuplicateService,
} from "./application/potential-duplicate-service.ts";
