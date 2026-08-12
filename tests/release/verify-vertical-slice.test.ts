import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  verificationExitCode,
  verifyVerticalSliceEvidence,
  VERTICAL_SLICE_EXIT_CODE,
  VerticalSliceEvidenceError,
} from "../../scripts/release/verify-vertical-slice.ts";
import {
  createEvidenceManifest,
  type EvidenceManifestInput,
} from "../../scripts/evidence/create-manifest.ts";

const FIXTURE_DIRECTORY = resolve("evidence/release1/p1-18");

async function copiedEvidenceFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tianxing-p1-18-"));
  await cp(FIXTURE_DIRECTORY, directory, { recursive: true });
  return directory;
}

test("verifies the immutable local bundle but keeps Release 1 at no-go", async () => {
  const result = await verifyVerticalSliceEvidence();

  assert.equal(result.integrity, "pass");
  assert.equal(result.verification, "pass");
  assert.equal(result.releaseState, "needs_human");
  assert.equal(result.decision, "no_go");
  assert.deepEqual(result.requiredExternalEvidence.map(({ id }) => id), [
    "application.compatible-prior-image",
    "migration.corrective-path",
    "restore.database-isolated",
    "restore.document-linkage",
  ]);
  assert.equal(verificationExitCode(result, false), VERTICAL_SLICE_EXIT_CODE.verifiedLocalEvidence);
  assert.equal(verificationExitCode(result, true), VERTICAL_SLICE_EXIT_CODE.noGo);
});

test("fails closed when a checksummed artifact is changed", async (context) => {
  const directory = await copiedEvidenceFixture();
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, "scenarios/local-evidence-integrity.json"),
    "{\"artifact_set\":\"altered\"}\n",
    "utf8",
  );

  await assert.rejects(
    () => verifyVerticalSliceEvidence({ evidenceDirectory: directory }),
    (error: unknown) =>
      error instanceof VerticalSliceEvidenceError && error.code === "EVIDENCE_TAMPERED",
  );
});

test("fails closed when a manifest-referenced artifact is missing", async (context) => {
  const directory = await copiedEvidenceFixture();
  context.after(() => rm(directory, { recursive: true, force: true }));
  await unlink(join(directory, "scenarios/restore-document-linkage.json"));

  await assert.rejects(
    () => verifyVerticalSliceEvidence({ evidenceDirectory: directory }),
    (error: unknown) =>
      error instanceof VerticalSliceEvidenceError && error.code === "EVIDENCE_LAYOUT_INVALID",
  );
});

test("does not accept a fully regenerated local bundle with a changed input", async (context) => {
  const directory = await copiedEvidenceFixture();
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = JSON.parse(
    await readFile(join(directory, "manifest-input.json"), "utf8"),
  ) as EvidenceManifestInput;
  const changedInput: EvidenceManifestInput = {
    ...input,
    runId: "p1-18-local-altered",
  };
  await writeFile(
    join(directory, "manifest-input.json"),
    `${JSON.stringify(changedInput, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(directory, "manifest.json"),
    `${JSON.stringify(createEvidenceManifest(changedInput), null, 2)}\n`,
    "utf8",
  );

  await assert.rejects(
    () => verifyVerticalSliceEvidence({ evidenceDirectory: directory }),
    (error: unknown) =>
      error instanceof VerticalSliceEvidenceError && error.code === "EVIDENCE_TAMPERED",
  );
});
