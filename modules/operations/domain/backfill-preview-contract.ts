export type BackfillPreview = {
  reportVersion: 1;
  source: {
    kind: "synthetic";
    version: string;
  };
  mapping: {
    version: string;
    sourceEntity: string;
    targetEntity: string;
  };
  schemaVersion: string;
  execution: {
    mode: "preview_only";
    sourceWrites: "forbidden";
    targetWrites: "forbidden";
  };
  counts: {
    source: number;
    accepted: number;
    rejected: number;
    target: number;
  };
  rejections: readonly unknown[];
  reconciliation: {
    status: "reconciled" | "needs_human";
    unexplainedDifference: number;
  };
  resumeKey: string;
  hashes: {
    sourceSha256: string;
    mappingSha256: string;
    acceptedTargetSha256: string;
    reportSha256: string;
  };
};
