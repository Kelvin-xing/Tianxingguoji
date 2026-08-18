import "server-only";

import {
  AUTH_MODES,
  loadRuntimeEnvironment,
  RuntimeEnvironmentConfigurationError,
  type AuthMode,
  type RuntimeEnvironment,
} from "../../../lib/runtime/runtime-environment.ts";

export {
  AUTH_MODES,
  RuntimeEnvironmentConfigurationError,
  RuntimeEnvironmentConfigurationError as AuthModeConfigurationError,
};
export type { AuthMode };

export function loadAuthMode(environment: RuntimeEnvironment = process.env): AuthMode {
  return loadRuntimeEnvironment(environment).authMode;
}
