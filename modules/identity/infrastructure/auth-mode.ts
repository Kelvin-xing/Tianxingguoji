import "server-only";

export const AUTH_MODES = ["local-synthetic", "cognito"] as const;

export type AuthMode = (typeof AUTH_MODES)[number];

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export class AuthModeConfigurationError extends Error {
  readonly variable: string;

  constructor(variable: string) {
    super(`Authentication mode rejected ${variable}.`);
    this.name = "AuthModeConfigurationError";
    this.variable = variable;
  }
}

export function loadAuthMode(environment: RuntimeEnvironment = process.env): AuthMode {
  const mode = environment.AUTH_MODE?.trim();
  if (mode !== "local-synthetic" && mode !== "cognito") {
    throw new AuthModeConfigurationError("AUTH_MODE");
  }

  if (mode === "local-synthetic") {
    if (environment.APP_RUNTIME_MODE?.trim() !== "local-synthetic") {
      throw new AuthModeConfigurationError("APP_RUNTIME_MODE");
    }
    if (environment.NODE_ENV?.trim() === "production") {
      throw new AuthModeConfigurationError("NODE_ENV");
    }
  }

  return mode;
}
