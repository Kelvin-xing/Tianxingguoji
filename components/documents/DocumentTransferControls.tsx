"use client";

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";

import { Icon } from "@/components/workspace/Icon";
import {
  DOCUMENT_UPLOAD_CONTENT_TYPES,
  DocumentIdempotencyAttempt,
  DocumentTransferError,
  abandonDocumentVersion,
  classifyDocumentFailure,
  createDocumentVersion,
  digestDocumentUploadFile,
  documentAbandonmentFingerprint,
  documentVersionFingerprint,
  fetchDocumentBytes,
  getCaseDocument,
  issueDocumentDownloadIntent,
  issueDocumentUploadIntent,
  pollCaseDocumentUntilSettled,
  putDocumentBytes,
  validateDocumentUploadFile,
  type DocumentListItem,
  type DocumentVersionState,
} from "@/modules/documents/client";

type TransferNotice =
  | "hashing"
  | "creating"
  | "uploading"
  | "scanning"
  | "available"
  | "rejected"
  | "scan_failed"
  | "downloaded"
  | "abandoning"
  | "abandoned"
  | "validation"
  | "stale"
  | "conflict"
  | "recovery_conflict"
  | "denied"
  | "timeout"
  | "unavailable"
  | null;

interface PendingUploadAttempt {
  readonly file: File;
  readonly digest: Awaited<ReturnType<typeof digestDocumentUploadFile>>;
  readonly command: Parameters<typeof createDocumentVersion>[2];
  receipt: Awaited<ReturnType<typeof createDocumentVersion>> | null;
}

export function DocumentTransferControls({
  caseId,
  document,
  canUpload,
  canDownload,
  onAuthoritativeChange,
}: {
  readonly caseId: string;
  readonly document: DocumentListItem;
  readonly canUpload: boolean;
  readonly canDownload: boolean;
  readonly onAuthoritativeChange: (document: DocumentListItem) => void;
}) {
  const mounted = useRef(false);
  const uploadLocked = useRef(false);
  const abandonLocked = useRef(false);
  const downloadLocked = useRef(false);
  const pollController = useRef<AbortController | null>(null);
  const attempt = useRef<DocumentIdempotencyAttempt | null>(null);
  const abandonmentAttempt = useRef<DocumentIdempotencyAttempt | null>(null);
  const pendingAttempt = useRef<PendingUploadAttempt | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  if (attempt.current === null) attempt.current = new DocumentIdempotencyAttempt();
  if (abandonmentAttempt.current === null) abandonmentAttempt.current = new DocumentIdempotencyAttempt();

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadPending, setUploadPending] = useState(false);
  const [abandonPending, setAbandonPending] = useState(false);
  const [abandonConfirmed, setAbandonConfirmed] = useState(false);
  const [downloadPending, setDownloadPending] = useState(false);
  const [notice, setNotice] = useState<TransferNotice>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pollController.current?.abort();
    };
  }, []);

  useEffect(() => {
    if ((notice !== "available" && notice !== "abandoned") || uploadPending || abandonPending) return;
    const input = fileInput.current;
    if (input === null || input.disabled) return;
    input.focus();
  }, [notice, uploadPending, abandonPending]);

  const canRecover = document.latest_version_state === "pending_upload" && document.pending_upload !== null;
  const uploadAllowed = canUpload
    && document.lifecycle_state === "active"
    && (!isInFlight(document.latest_version_state) || canRecover);
  const abandonAllowed = canUpload && document.lifecycle_state === "active" && canRecover;
  const downloadAllowed = canDownload
    && document.lifecycle_state === "active"
    && document.has_active_version;

  function selectFile(event: ChangeEvent<HTMLInputElement>) {
    attempt.current!.rotate();
    pendingAttempt.current = null;
    setNotice(null);
    const file = event.target.files?.item(0) ?? null;
    if (file === null) {
      setSelectedFile(null);
      return;
    }
    try {
      validateDocumentUploadFile(file);
      setSelectedFile(file);
    } catch {
      event.target.value = "";
      setSelectedFile(null);
      setNotice("validation");
    }
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (uploadLocked.current || uploadPending || !uploadAllowed) return;
    if (selectedFile === null) {
      setNotice("validation");
      return;
    }
    uploadLocked.current = true;
    setUploadPending(true);
    setNotice("hashing");
    const expectedDocumentVersion = document.record_version;
    try {
      let currentAttempt = pendingAttempt.current;
      if (currentAttempt === null || currentAttempt.file !== selectedFile) {
        const digest = await digestDocumentUploadFile(selectedFile);
        const command = {
          checksum_sha256: digest.checksum_sha256,
          size_bytes: digest.size_bytes,
          content_type: digest.content_type,
          expected_document_record_version: expectedDocumentVersion,
        } as const;
        currentAttempt = { file: selectedFile, digest, command, receipt: null };
        pendingAttempt.current = currentAttempt;
      }
      const authoritativePending = document.pending_upload;
      if (mounted.current) setNotice(authoritativePending === null ? "creating" : "uploading");
      const receipt = authoritativePending ?? currentAttempt.receipt ?? await createDocumentVersion(
          caseId,
          document.id,
          currentAttempt.command,
          attempt.current!.keyFor(documentVersionFingerprint(currentAttempt.command)),
        );
      currentAttempt.receipt = receipt;
      const afterCreate = await getCaseDocument(caseId, document.id);
      const afterCreatePending = afterCreate.document.pending_upload;
      const expectedAuthorityVersion = expectedDocumentVersion
        + (authoritativePending === null ? 1 : 0);
      if (afterCreate.document.record_version !== expectedAuthorityVersion
        || afterCreatePending?.id !== receipt.id
        || afterCreatePending.record_version !== receipt.record_version) {
        throw new DocumentTransferError("conflict");
      }
      if (mounted.current) onAuthoritativeChange(afterCreate.document);

      let currentState = afterCreate.document.latest_version_state;
      if (currentState === "pending_upload") {
        const intent = await issueDocumentUploadIntent(
          caseId,
          document.id,
          receipt.id,
          receipt.record_version,
          currentAttempt.digest,
        );
        if (mounted.current) setNotice("uploading");
        await putDocumentBytes(intent, selectedFile);
        currentState = "quarantined";
      }

      if (isSettled(currentState)) {
        completeUpload(currentState);
        return;
      }
      if (currentState !== "quarantined" && currentState !== "scanning") {
        throw new DocumentTransferError("conflict");
      }

      if (mounted.current) setNotice("scanning");
      const nextController = new AbortController();
      pollController.current = nextController;
      const settled = await pollCaseDocumentUntilSettled(caseId, document.id, {
        signal: nextController.signal,
        onAuthoritativeChange: (authoritative) => {
          if (mounted.current) onAuthoritativeChange(authoritative);
        },
      });
      completeUpload(settled.document.latest_version_state);
    } catch (error) {
      if (!mounted.current) return;
      const failure = classifyDocumentFailure(error);
      const recoverableTransfer = error instanceof DocumentTransferError && error.recoverable;
      if (failure === "stale") {
        attempt.current!.rotate();
        pendingAttempt.current = null;
        try {
          const authoritative = await getCaseDocument(caseId, document.id);
          if (mounted.current) {
            onAuthoritativeChange(authoritative.document);
            setNotice("stale");
          }
        } catch {
          if (mounted.current) setNotice("unavailable");
        }
        return;
      }
      if (failure === "conflict" && !recoverableTransfer) {
        attempt.current!.rotate();
        pendingAttempt.current = null;
        try {
          const authoritative = await getCaseDocument(caseId, document.id);
          if (mounted.current) {
            onAuthoritativeChange(authoritative.document);
            setNotice(canRecover ? "recovery_conflict" : "conflict");
          }
        } catch {
          if (mounted.current) setNotice("unavailable");
        }
        return;
      }
      if (failure !== "unavailable" && failure !== "timeout" && !recoverableTransfer) {
        attempt.current!.rotate();
        pendingAttempt.current = null;
      }
      setNotice(
        failure === "validation" ? "validation"
          : failure === "conflict" && canRecover ? "recovery_conflict"
            : failure === "conflict" ? "conflict"
            : failure === "forbidden" || failure === "unauthenticated" || failure === "not_found" ? "denied"
              : failure === "timeout" ? "timeout"
                : "unavailable",
      );
    } finally {
      uploadLocked.current = false;
      pollController.current = null;
      if (mounted.current) setUploadPending(false);
    }
  }

  function completeUpload(state: DocumentVersionState | null) {
    if (!mounted.current) return;
    if (state !== "available" && state !== "rejected" && state !== "scan_failed") {
      throw new DocumentTransferError("conflict");
    }
    attempt.current!.complete();
    pendingAttempt.current = null;
    setNotice(state);
    if (state === "available") {
      setSelectedFile(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function abandonPendingUpload() {
    if (abandonLocked.current || abandonPending || !abandonAllowed || !abandonConfirmed) return;
    const pendingUpload = document.pending_upload;
    if (pendingUpload === null) return;
    const input = {
      expected_document_record_version: document.record_version,
      expected_version_record_version: pendingUpload.record_version,
    } as const;
    abandonLocked.current = true;
    setAbandonPending(true);
    setNotice("abandoning");
    try {
      const receipt = await abandonDocumentVersion(
        caseId,
        document.id,
        pendingUpload.id,
        input,
        abandonmentAttempt.current!.keyFor(documentAbandonmentFingerprint(input)),
      );
      if (receipt.id !== pendingUpload.id || receipt.record_version !== pendingUpload.record_version + 1) {
        throw new DocumentTransferError("conflict");
      }
      const authoritative = await getCaseDocument(caseId, document.id);
      if (authoritative.document.record_version !== document.record_version + 1
        || authoritative.document.latest_version_state !== "abandoned"
        || authoritative.document.pending_upload !== null) {
        throw new DocumentTransferError("conflict");
      }
      if (!mounted.current) return;
      abandonmentAttempt.current!.complete();
      attempt.current!.complete();
      pendingAttempt.current = null;
      setAbandonConfirmed(false);
      setSelectedFile(null);
      if (fileInput.current) fileInput.current.value = "";
      onAuthoritativeChange(authoritative.document);
      setNotice("abandoned");
    } catch (error) {
      if (!mounted.current) return;
      const failure = classifyDocumentFailure(error);
      if (failure === "stale" || failure === "conflict") {
        try {
          const authoritative = await getCaseDocument(caseId, document.id);
          if (mounted.current) onAuthoritativeChange(authoritative.document);
        } catch {
          if (mounted.current) setNotice("unavailable");
          return;
        }
      }
      setNotice(
        failure === "stale" ? "stale"
          : failure === "conflict" ? "conflict"
            : failure === "forbidden" || failure === "unauthenticated" || failure === "not_found" ? "denied"
              : "unavailable",
      );
    } finally {
      abandonLocked.current = false;
      if (mounted.current) setAbandonPending(false);
    }
  }

  async function download() {
    if (downloadLocked.current || downloadPending || !downloadAllowed) return;
    downloadLocked.current = true;
    setDownloadPending(true);
    setNotice(null);
    try {
      const intent = await issueDocumentDownloadIntent(caseId, document.id);
      const bytes = await fetchDocumentBytes(intent);
      const objectUrl = URL.createObjectURL(bytes);
      try {
        const anchor = globalThis.document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = intent.download_name;
        anchor.hidden = true;
        globalThis.document.body.append(anchor);
        anchor.click();
        anchor.remove();
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
      const authoritative = await getCaseDocument(caseId, document.id);
      if (mounted.current) {
        onAuthoritativeChange(authoritative.document);
        setNotice("downloaded");
      }
    } catch (error) {
      if (!mounted.current) return;
      const failure = classifyDocumentFailure(error);
      setNotice(
        failure === "conflict" ? "conflict"
          : failure === "forbidden" || failure === "unauthenticated" || failure === "not_found" ? "denied"
            : "unavailable",
      );
    } finally {
      downloadLocked.current = false;
      if (mounted.current) setDownloadPending(false);
    }
  }

  if (!canUpload && !canDownload) return null;

  return (
    <div className="pt-3 mt-3 border-t space-y-3" style={{ borderColor: "var(--border-subtle)" }}>
      {uploadAllowed ? (
        <form className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto] gap-3 items-end" onSubmit={upload} aria-busy={uploadPending}>
          <label className="field-label min-w-0">
            {canRecover ? "重新選擇原上載文件" : "選擇上載文件"}
            <input
              ref={fileInput}
              type="file"
              accept={DOCUMENT_UPLOAD_CONTENT_TYPES.join(",")}
              required
              disabled={uploadPending}
              onChange={selectFile}
            />
          </label>
          <button type="submit" className="primary-button justify-center sm:min-w-40" disabled={uploadPending} aria-busy={uploadPending}>
            <Icon name={uploadPending ? "clock" : "upload"} size={15} />
            {uploadPending ? "正在處理" : canRecover ? "繼續上載並掃描" : "上載並掃描"}
          </button>
          {selectedFile ? <p className="sm:col-span-2 text-xs break-all" style={{ color: "var(--text-muted)" }}>已選擇：{selectedFile.name}</p> : null}
        </form>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {canUpload && document.lifecycle_state === "active" && isInFlight(document.latest_version_state) ? (
          <span className="inline-callout" role="status"><Icon name="clock" size={15} /><span>{canRecover ? "待上載版本可重新選擇原文件繼續，或確認放棄後重新開始。" : "目前版本仍在掃描，完成前不能開始另一個版本。"}</span></span>
        ) : null}
        {canDownload ? (
          <button type="button" className="secondary-button" disabled={!downloadAllowed || downloadPending} aria-busy={downloadPending} onClick={() => void download()}>
            <Icon name={downloadPending ? "clock" : "file-text"} size={15} />
            {downloadPending ? "正在準備下載" : "下載安全版本"}
          </button>
        ) : null}
      </div>

      {abandonAllowed ? (
        <div className="border-t pt-3 space-y-3" style={{ borderColor: "var(--border-subtle)" }}>
          <label className="checkbox-row">
            <input
              type="checkbox"
              aria-label="確認放棄待上載版本"
              checked={abandonConfirmed}
              disabled={abandonPending || uploadPending}
              onChange={(event) => { setAbandonConfirmed(event.target.checked); setNotice(null); }}
            />
            <span className="min-w-0 break-words">我確認放棄目前待上載版本；即使舊連結在到期前被使用，遲到物件也只會由系統清理，不會進入掃描或成為可下載版本。</span>
          </label>
          <button
            type="button"
            className="secondary-button"
            disabled={!abandonConfirmed || abandonPending || uploadPending}
            aria-busy={abandonPending}
            onClick={() => void abandonPendingUpload()}
          >
            <Icon name={abandonPending ? "clock" : "x"} size={15} />
            {abandonPending ? "正在放棄" : "放棄待上載版本"}
          </button>
        </div>
      ) : null}

      <TransferNotice notice={notice} />
    </div>
  );
}

function isInFlight(state: DocumentVersionState | null): boolean {
  return state === "pending_upload" || state === "quarantined" || state === "scanning";
}

function isSettled(state: DocumentVersionState | null): state is "available" | "rejected" | "scan_failed" {
  return state === "available" || state === "rejected" || state === "scan_failed";
}

function TransferNotice({ notice }: { readonly notice: TransferNotice }) {
  if (notice === null) return null;
  const message = notice === "hashing" ? "正在本機計算文件校驗值。"
    : notice === "creating" ? "正在建立待上載版本。"
      : notice === "uploading" ? "正在上載至私人儲存空間。"
        : notice === "scanning" ? "上載完成，正在進行安全掃描。"
          : notice === "available" ? "掃描完成，安全版本已可下載。"
            : notice === "rejected" ? "文件未通過完整性或安全檢查，不能下載。"
              : notice === "scan_failed" ? "安全掃描未能完成，可稍後建立新版本。"
                : notice === "downloaded" ? "安全版本已下載，文件狀態已重新確認。"
                  : notice === "abandoning" ? "正在放棄待上載版本。"
                    : notice === "abandoned" ? "待上載版本已放棄，文件狀態已重新載入，可建立新版本。"
                  : notice === "validation" ? "請選擇一個 PDF、JPEG 或 PNG 文件；大小須為 1 byte 至 10 MiB。"
                    : notice === "stale" ? "文件已被更新，已重新載入目前版本，請再確認後上載。"
                      : notice === "recovery_conflict" ? "所選文件與待上載版本不一致，未上載任何內容；請重新選擇原文件或放棄待上載版本。"
                        : notice === "conflict" ? "文件狀態已變更或操作已逾期，請重新確認。"
                        : notice === "denied" ? "目前帳號不能操作這份案件文件。"
                          : notice === "timeout" ? "掃描仍未在 90 秒內完成，可稍後重新檢查。"
                            : "結果暫時無法確認，請稍後重試；重試不會重複建立版本。";
  const isStatus = ["hashing", "creating", "uploading", "scanning", "available", "downloaded", "abandoning", "abandoned"].includes(notice);
  return (
    <div className={isStatus ? "inline-callout" : notice === "rejected" || notice === "scan_failed" || notice === "timeout" ? "inline-callout warning" : "form-error"} role={isStatus ? "status" : "alert"}>
      <Icon name={isStatus ? notice === "available" || notice === "downloaded" || notice === "abandoned" ? "check-circle" : "clock" : "shield"} size={15} />
      <span>{message}</span>
    </div>
  );
}
