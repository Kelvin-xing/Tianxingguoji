import "server-only";

export type KBPayload = {
  data: Record<string, unknown>;
  schoolNames: Record<string, string>;
};

export class FutureKnowledgeFeatureUnavailable extends Error {
  readonly code = "FUTURE_KNOWLEDGE_FEATURE_FROZEN" as const;

  constructor() {
    super("Knowledge base is frozen outside the Release 1 scope.");
    this.name = "FutureKnowledgeFeatureUnavailable";
  }
}

export async function getKnowledgeBase(): Promise<never> {
  throw new FutureKnowledgeFeatureUnavailable();
}

export async function saveKnowledgeBase(_payload: KBPayload): Promise<never> {
  throw new FutureKnowledgeFeatureUnavailable();
}
