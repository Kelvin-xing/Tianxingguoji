import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { DeleteObjectCommand, HeadObjectCommand, type S3Client } from "@aws-sdk/client-s3";

import { createOpaqueDocumentObjectKey } from "../../../modules/documents/domain/contract.ts";
import {
  LocalDocumentObjectStoreUnavailable,
  LocalSyntheticDocumentObjectStore,
} from "../../../modules/documents/infrastructure/local-object-store.ts";

const BUCKET = "tianxing-documents-local";
const KEY = createOpaqueDocumentObjectKey(
  "81000000-0000-4000-8000-000000000001",
  "81000000-0000-4000-8000-000000000002",
);

test("upload capability signs exact MIME and checksum headers without query hoisting", async () => {
  const checksum = createHash("sha256").update("DOC02 signed upload evidence").digest("base64");
  const store = new LocalSyntheticDocumentObjectStore({
    endpoint: "http://127.0.0.1:4566",
    bucket: BUCKET,
  });
  const result = await store.issueUploadIntent({
    bucket: BUCKET,
    key: KEY,
    contentType: "application/pdf",
    checksumSha256Base64: checksum,
    expiresInSeconds: 600,
  });
  const url = new URL(result.url);
  assert.deepEqual(
    (url.searchParams.get("X-Amz-SignedHeaders") ?? "").split(";").sort(),
    ["content-type", "host", "x-amz-checksum-sha256"],
  );
  assert.equal(url.searchParams.has("x-amz-checksum-sha256"), false);
  assert.equal(url.searchParams.has("X-Amz-Checksum-Sha256"), false);
});

test("deletes only the exact bucket, key and provider version", async () => {
  const commands: DeleteObjectCommand[] = [];
  const store = objectStore(async (command) => {
    assert.ok(command instanceof DeleteObjectCommand);
    commands.push(command);
    return { VersionId: "provider-v1" };
  });
  assert.equal(await store.deleteExact({
    bucket: BUCKET,
    key: KEY,
    providerVersionId: "provider-v1",
  }), "deleted");
  assert.deepEqual(commands[0]?.input, {
    Bucket: BUCKET,
    Key: KEY,
    VersionId: "provider-v1",
  });
});

test("rejects a wrong bucket or non-opaque key before contacting S3", async () => {
  let calls = 0;
  const store = objectStore(async () => {
    calls += 1;
    return { VersionId: "provider-v1" };
  });
  for (const input of [
    { bucket: "wrong-document-bucket", key: KEY },
    { bucket: BUCKET, key: "documents/not-an-opaque-coordinate" },
  ]) {
    await assert.rejects(
      () => store.deleteExact({ ...input, providerVersionId: "provider-v1" }),
      LocalDocumentObjectStoreUnavailable,
    );
  }
  assert.equal(calls, 0);
});

test("proves a LocalStack-style empty delete response absent with an exact HEAD", async () => {
  const commands: unknown[] = [];
  const signals: unknown[] = [];
  const store = objectStore(async (command, options) => {
    commands.push(command);
    signals.push((options as { readonly abortSignal?: unknown } | undefined)?.abortSignal);
    if (command instanceof DeleteObjectCommand) return {};
    assert.ok(command instanceof HeadObjectCommand);
    throw s3Error("NoSuchVersion", 404);
  });
  assert.equal(await store.deleteExact({
    bucket: BUCKET,
    key: KEY,
    providerVersionId: "provider-v1",
  }), "already_absent");
  assert.deepEqual(commands.map((command) => {
    assert.ok(command instanceof DeleteObjectCommand || command instanceof HeadObjectCommand);
    return command.input;
  }), [{
    Bucket: BUCKET,
    Key: KEY,
    VersionId: "provider-v1",
  }, {
    Bucket: BUCKET,
    Key: KEY,
    VersionId: "provider-v1",
  }]);
  assert.equal(signals.length, 2);
  assert.equal(signals[0], signals[1]);
});

test("requires an exact HEAD absence proof after NoSuchVersion from delete", async () => {
  let calls = 0;
  assert.equal(await objectStore(async (command) => {
    calls += 1;
    if (command instanceof DeleteObjectCommand) throw s3Error("NoSuchVersion", 404);
    assert.ok(command instanceof HeadObjectCommand);
    throw s3Error("NoSuchKey", 404);
  }).deleteExact({
    bucket: BUCKET,
    key: KEY,
    providerVersionId: "provider-v1",
  }), "already_absent");
  assert.equal(calls, 2);
});

test("proves an exact LocalStack missing-version response absent without touching a bound version", async () => {
  const commands: unknown[] = [];
  assert.equal(await objectStore(async (command) => {
    commands.push(command);
    if (command instanceof DeleteObjectCommand) {
      throw s3Error("InvalidArgument", 400, {
        ArgumentName: "versionId",
        ArgumentValue: "provider-v1",
      });
    }
    assert.ok(command instanceof HeadObjectCommand);
    throw s3Error("NoSuchVersion", 404);
  }).deleteExact({
    bucket: BUCKET,
    key: KEY,
    providerVersionId: "provider-v1",
  }), "already_absent");
  assert.deepEqual(commands.map((command) => {
    assert.ok(command instanceof DeleteObjectCommand || command instanceof HeadObjectCommand);
    return command.input;
  }), [{
    Bucket: BUCKET,
    Key: KEY,
    VersionId: "provider-v1",
  }, {
    Bucket: BUCKET,
    Key: KEY,
    VersionId: "provider-v1",
  }]);
});

test("fails closed when an ambiguous delete is followed by a present or mismatched HEAD", async () => {
  for (const headResult of [
    { VersionId: "provider-v1" },
    { VersionId: "provider-v2" },
    {},
  ]) {
    await assert.rejects(
      () => objectStore(async (command) => {
        if (command instanceof DeleteObjectCommand) return {};
        assert.ok(command instanceof HeadObjectCommand);
        return headResult;
      }).deleteExact({
        bucket: BUCKET,
        key: KEY,
        providerVersionId: "provider-v1",
      }),
      LocalDocumentObjectStoreUnavailable,
    );
  }
});

test("fails closed immediately on an unexpected non-empty delete VersionId", async () => {
  let calls = 0;
  await assert.rejects(
    () => objectStore(async (command) => {
      calls += 1;
      assert.ok(command instanceof DeleteObjectCommand);
      return { VersionId: "provider-v2" };
    }).deleteExact({
      bucket: BUCKET,
      key: KEY,
      providerVersionId: "provider-v1",
    }),
    LocalDocumentObjectStoreUnavailable,
  );
  assert.equal(calls, 1);
});

test("does not treat non-allowlisted delete or HEAD errors as absence", async () => {
  for (const error of [
    s3Error("NoSuchVersion", 500),
    s3Error("NoSuchKey", 404),
    s3Error("InvalidArgument", 404, {
      ArgumentName: "versionId",
      ArgumentValue: "provider-v1",
    }),
    s3Error("InvalidArgument", 400),
    s3Error("InvalidArgument", 400, {
      ArgumentName: "key",
      ArgumentValue: "provider-v1",
    }),
    s3Error("InvalidArgument", 400, {
      ArgumentName: "versionId",
      ArgumentValue: "provider-v2",
    }),
    s3Error("S3ServiceException", 400, {
      ArgumentName: "versionId",
      ArgumentValue: "provider-v1",
    }),
    s3Error("Unknown", 400, {
      ArgumentName: "versionId",
      ArgumentValue: "provider-v1",
    }),
    s3Error("AccessDenied", 403),
    s3Error("NoSuchBucket", 404),
    inheritedS3Error("InvalidArgument", 400, {
      ArgumentName: "versionId",
      ArgumentValue: "provider-v1",
    }),
    new Error("transport failure"),
  ]) {
    let calls = 0;
    await assert.rejects(
      () => objectStore(async () => {
        calls += 1;
        throw error;
      }).deleteExact({
        bucket: BUCKET,
        key: KEY,
        providerVersionId: "provider-v1",
      }),
      LocalDocumentObjectStoreUnavailable,
    );
    assert.equal(calls, 1);
  }

  for (const error of [
    s3Error("NoSuchVersion", 500),
    s3Error("AccessDenied", 403),
    new Error("transport failure"),
  ]) {
    await assert.rejects(
      () => objectStore(async (command) => {
        if (command instanceof DeleteObjectCommand) return {};
        assert.ok(command instanceof HeadObjectCommand);
        throw error;
      }).deleteExact({
        bucket: BUCKET,
        key: KEY,
        providerVersionId: "provider-v1",
      }),
      LocalDocumentObjectStoreUnavailable,
    );
  }
});

test("bounds delete and absence proof under one abort deadline", async () => {
  await assert.rejects(
    () => objectStore(async (command, options) => {
      if (command instanceof DeleteObjectCommand) return {};
      assert.ok(command instanceof HeadObjectCommand);
      const signal = (options as { readonly abortSignal?: AbortSignal } | undefined)?.abortSignal;
      assert.ok(signal);
      await new Promise<never>((_resolve, reject) => {
        const abort = () => reject(Object.assign(new Error("redacted"), { name: "AbortError" }));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    }).deleteExact({
      bucket: BUCKET,
      key: KEY,
      providerVersionId: "provider-v1",
    }),
    LocalDocumentObjectStoreUnavailable,
  );
});

function s3Error(
  name: string,
  httpStatusCode: number,
  fields: Readonly<Record<string, unknown>> = {},
): Error {
  return Object.assign(new Error("redacted"), fields, { name, $metadata: { httpStatusCode } });
}

function inheritedS3Error(
  name: string,
  httpStatusCode: number,
  fields: Readonly<Record<string, unknown>>,
): Error {
  const error = Object.assign(new Error("redacted"), { name, $metadata: { httpStatusCode } });
  Object.setPrototypeOf(error, Object.assign(Object.create(Error.prototype), fields));
  return error;
}

function objectStore(
  send: (command: unknown, options?: unknown) => Promise<unknown>,
): LocalSyntheticDocumentObjectStore {
  return new LocalSyntheticDocumentObjectStore({
    endpoint: "http://127.0.0.1:4566",
    bucket: BUCKET,
    requestTimeoutMs: 250,
    client: { send } as unknown as S3Client,
  });
}
