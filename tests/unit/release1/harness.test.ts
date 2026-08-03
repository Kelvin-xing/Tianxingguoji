import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  createEvidenceManifest,
  EvidenceInputError,
  writeEvidenceBundle,
  type EvidenceManifestInput,
} from "../../../scripts/evidence/create-manifest.ts";
import { SyntheticClock } from "../../fakes/clock.ts";
import { SyntheticCognitoError, SyntheticCognitoFake } from "../../fakes/cognito.ts";
import {
  SyntheticS3Error,
  SyntheticS3Fake,
} from "../../fakes/s3.ts";
import {
  SyntheticScannerError,
  SyntheticScannerFake,
} from "../../fakes/scanner.ts";

const FIXTURE_PATH = resolve("tests/fixtures/release1/p0-12-input.json");
const OBJECT_KEY =
  "documents/10000000-0000-4000-8000-000000000201/versions/20000000-0000-4000-8000-000000000201";
const CHECKSUM = "a".repeat(64);

test("keeps time, identity, object, and scanner adapters deterministic", async () => {
  const clock = new SyntheticClock("2026-08-03T00:00:00.000Z");
  assert.equal(clock.nowIso(), "2026-08-03T00:00:00.000Z");
  assert.equal(clock.advance(30_000), "2026-08-03T00:00:30.000Z");
  assert.equal(clock.set("2026-08-03T00:01:00.000Z"), "2026-08-03T00:01:00.000Z");

  const cognito = new SyntheticCognitoFake({ authenticate: "timeout" });
  await assert.rejects(
    () =>
      cognito.authenticate({
        requestId: "request-p0-12-201",
        providerSubject: "synthetic-user-001",
      }),
    (error: unknown) =>
      error instanceof SyntheticCognitoError &&
      error.code === "COGNITO_TIMEOUT" &&
      error.retryable,
  );
  const identity = await new SyntheticCognitoFake().authenticate({
    requestId: "request-p0-12-202",
    providerSubject: "synthetic-user-002",
  });
  assert.deepEqual(identity, {
    operation: "authenticate",
    status: "authenticated",
    providerSubject: "synthetic-user-002",
    errorCode: null,
    retryable: false,
  });

  const scanner = new SyntheticScannerFake("timeout", "malicious", "clean");
  await assert.rejects(
    () =>
      scanner.scan({
        requestId: "scan-p0-12-201",
        objectKey: OBJECT_KEY,
        objectVersionId: "synthetic-version-1",
      }),
    (error: unknown) => error instanceof SyntheticScannerError && error.code === "SCANNER_TIMEOUT",
  );
  assert.equal(
    (
      await scanner.scan({
        requestId: "scan-p0-12-202",
        objectKey: OBJECT_KEY,
        objectVersionId: "synthetic-version-1",
      })
    ).verdict,
    "malicious",
  );
  assert.equal(
    (
      await scanner.scan({
        requestId: "scan-p0-12-203",
        objectKey: OBJECT_KEY,
        objectVersionId: "synthetic-version-1",
      })
    ).verdict,
    "clean",
  );
});

test("injects object storage timeout, lost event, and replay without real bytes", async () => {
  const objectStore = new SyntheticS3Fake();
  objectStore.enqueue("put_object", "timeout", "success");
  await assert.rejects(
    () =>
      objectStore.putObject({
        region: "ap-east-1",
        bucket: "synthetic-release1-documents",
        key: OBJECT_KEY,
        versionId: "synthetic-version-1",
        checksumSha256: CHECKSUM,
        sizeBytes: 128,
      }),
    (error: unknown) => error instanceof SyntheticS3Error && error.code === "S3_TIMEOUT",
  );
  const stored = await objectStore.putObject({
    region: "ap-east-1",
    bucket: "synthetic-release1-documents",
    key: OBJECT_KEY,
    versionId: "synthetic-version-1",
    checksumSha256: CHECKSUM,
    sizeBytes: 128,
  });
  assert.equal(stored.checksumSha256, CHECKSUM);

  objectStore.enqueue("record_event", "event_lost");
  await assert.rejects(
    () =>
      objectStore.recordObjectEvent({
        eventId: "object-event-p0-12-201",
        key: OBJECT_KEY,
        versionId: "synthetic-version-1",
      }),
    (error: unknown) => error instanceof SyntheticS3Error && error.code === "S3_EVENT_LOST",
  );
  assert.deepEqual(
    await objectStore.recordObjectEvent({
      eventId: "object-event-p0-12-201",
      key: OBJECT_KEY,
      versionId: "synthetic-version-1",
    }),
    { status: "accepted", eventId: "object-event-p0-12-201" },
  );
  assert.deepEqual(
    await objectStore.recordObjectEvent({
      eventId: "object-event-p0-12-201",
      key: OBJECT_KEY,
      versionId: "synthetic-version-1",
    }),
    { status: "duplicate", eventId: "object-event-p0-12-201" },
  );
  assert.equal(objectStore.objectCount(), 1);
  assert.equal(JSON.stringify(objectStore.calls()).includes("@"), false);
});

test("hashes a synthetic evidence bundle and keeps release eligibility fail closed", async () => {
  const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as EvidenceManifestInput;
  const first = createEvidenceManifest(fixture);
  const second = createEvidenceManifest(fixture);

  assert.equal(first.verification, "pass");
  assert.equal(first.releaseState, "blocked");
  assert.equal(first.approvalStatus, "not_requested");
  assert.equal(first.releaseEligible, false);
  assert.equal(first.redaction.rawPiiDetected, false);
  assert.equal(first.manifestSha256, second.manifestSha256);
  assert.deepEqual(
    first.scenarios.map(({ id }) => id),
    [
      "audit.pii_log_canary",
      "database.migration_checksum_mismatch",
      "document.scanner_rejection",
      "identity.provider_timeout",
      "object.event_replay",
      "restore.hash_mismatch",
    ],
  );

  const outputDirectory = await mkdtemp(join(tmpdir(), "tianxing-p0-12-"));
  const written = await writeEvidenceBundle(fixture, outputDirectory);
  const manifestOnDisk = JSON.parse(
    await readFile(join(outputDirectory, "manifest.json"), "utf8"),
  ) as EvidenceManifestInput;
  assert.equal(written.manifestSha256, first.manifestSha256);
  assert.equal(manifestOnDisk.source, "synthetic");
  assert.equal(
    await readFile(join(outputDirectory, "scenarios/restore-hash-mismatch.json"), "utf8"),
    fixture.artifacts.find(({ path }) => path === "scenarios/restore-hash-mismatch.json")?.content,
  );
});

test("does not turn a scenario mismatch or unsafe artifact into a pass", async () => {
  const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as EvidenceManifestInput;
  const mismatch: EvidenceManifestInput = {
    ...fixture,
    scenarios: fixture.scenarios.map((scenario, index) =>
      index === 0 ? { ...scenario, actualState: "blocked" as const } : scenario,
    ),
  };
  const mismatchManifest = createEvidenceManifest(mismatch);
  assert.equal(mismatchManifest.verification, "fail");
  assert.equal(mismatchManifest.releaseEligible, false);

  const unsafe = {
    ...fixture,
    artifacts: [
      {
        path: "scenarios/unsafe.json",
        content: "{\"email\":\"student@example.test\"}\n",
      },
    ],
    scenarios: [
      {
        id: "unsafe.input",
        description: "Synthetic fixture with unsafe text.",
        expectedState: "passed" as const,
        actualState: "passed" as const,
        evidence: { raw_pii_detected: false },
        artifactPaths: ["scenarios/unsafe.json"],
      },
    ],
  };
  assert.throws(
    () => createEvidenceManifest(unsafe),
    (error: unknown) => error instanceof EvidenceInputError,
  );

  const duplicateScenario: EvidenceManifestInput = {
    ...fixture,
    scenarios: [fixture.scenarios[0], fixture.scenarios[0]],
  };
  assert.throws(
    () => createEvidenceManifest(duplicateScenario),
    (error: unknown) => error instanceof EvidenceInputError,
  );

  const structuredSensitiveValue: EvidenceManifestInput = {
    ...fixture,
    artifacts: [
      {
        path: "scenarios/unsafe-structured.json",
        content: "{\"name\":\"synthetic-person\"}\n",
      },
    ],
    scenarios: [
      {
        id: "unsafe.structured",
        description: "Synthetic fixture with a forbidden structured key.",
        expectedState: "passed",
        actualState: "passed",
        evidence: { raw_pii_detected: false },
        artifactPaths: ["scenarios/unsafe-structured.json"],
      },
    ],
  };
  assert.throws(
    () => createEvidenceManifest(structuredSensitiveValue),
    (error: unknown) => error instanceof EvidenceInputError,
  );

  const incompleteApproval: EvidenceManifestInput = {
    ...fixture,
    approvals: [
      {
        gate: "security",
        status: "approved",
        reviewerId: null,
        payloadHash: null,
      },
    ],
  };
  assert.throws(
    () => createEvidenceManifest(incompleteApproval),
    (error: unknown) => error instanceof EvidenceInputError,
  );
});
