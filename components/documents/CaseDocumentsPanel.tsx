"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { Icon } from "@/components/workspace/Icon";
import { useTranslation } from "react-i18next";
import { Button, Card, Empty, FieldInput, FieldSelect, Notice } from "@/components/ui/standard";
import { CaseDocumentCard } from "./CaseDocumentCard";
import { getWorkspaceAccessSnapshot } from "@/modules/access/client";
import {
  DOCUMENT_CLASSIFICATIONS,
  DocumentIdempotencyAttempt,
  classifyDocumentFailure,
  documentRegistrationFingerprint,
  getCaseDocument,
  listCaseDocuments,
  registerCaseDocument,
  type DocumentClassification,
  type DocumentListItem,
} from "@/modules/documents/client";
import { DocumentTransferControls } from "./DocumentTransferControls";
import { DocumentLifecycleControls } from "./DocumentLifecycleControls";
import { classificationLabel } from "./document-ui";

type LoadState = "loading" | "ready" | "unauthenticated" | "denied" | "unavailable";
type Notice = "success" | "validation" | "conflict" | "denied" | "unavailable" | null;

export function CaseDocumentsPanel({ caseId }: { readonly caseId: string }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const mounted = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const submitting = useRef(false);
  const attempt = useRef<DocumentIdempotencyAttempt | null>(null);
  const nameInput = useRef<HTMLInputElement | null>(null);
  if (attempt.current === null) attempt.current = new DocumentIdempotencyAttempt();

  const [state, setState] = useState<LoadState>("loading");
  const [documents, setDocuments] = useState<readonly DocumentListItem[]>([]);
  const [canCreate, setCanCreate] = useState(false);
  const [canUpload, setCanUpload] = useState(false);
  const [canDownload, setCanDownload] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [classification, setClassification] = useState<DocumentClassification>("identity_and_case_evidence");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const load = useCallback(async () => {
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    setState("loading");
    try {
      const [result, access] = await Promise.all([
        listCaseDocuments(caseId, nextController.signal),
        getWorkspaceAccessSnapshot(nextController.signal),
      ]);
      if (!mounted.current || nextController.signal.aborted) return;
      if (!access.capabilities.some((capability) => String(capability) === "documents.read")) {
        setDocuments([]);
        setCanCreate(false);
        setCanUpload(false);
        setCanDownload(false);
        setState("denied");
        return;
      }
      setDocuments(result.documents);
      setCanCreate(access.capabilities.some((capability) => String(capability) === "documents.create"));
      setCanUpload(access.capabilities.some((capability) => String(capability) === "documents.upload"));
      setCanDownload(access.capabilities.some((capability) => String(capability) === "documents.download"));
      setState("ready");
    } catch (error) {
      if (!mounted.current || nextController.signal.aborted) return;
      const failure = classifyDocumentFailure(error);
      setDocuments([]);
      setCanCreate(false);
      setCanUpload(false);
      setCanDownload(false);
      setState(failure === "unauthenticated" ? "unauthenticated" : failure === "forbidden" || failure === "not_found" ? "denied" : "unavailable");
    } finally {
      if (controller.current === nextController) controller.current = null;
    }
  }, [caseId]);

  useEffect(() => {
    mounted.current = true;
    queueMicrotask(() => { if (mounted.current) void load(); });
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, [load]);

  function draftChanged() {
    attempt.current!.rotate();
    setNotice(null);
  }

  function updateAuthoritativeDocument(authoritative: DocumentListItem) {
    setDocuments((current) => current.map((document) => document.id === authoritative.id ? authoritative : document));
  }

  function clearDraft() {
    if (pending) return;
    attempt.current!.complete();
    setDisplayName("");
    setClassification("identity_and_case_evidence");
    setNotice(null);
    queueMicrotask(() => nameInput.current?.focus());
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || pending || !canCreate) return;
    const normalizedName = displayName.trim();
    if (normalizedName.length < 1 || normalizedName.length > 200) {
      setNotice("validation");
      return;
    }
    const input = { display_name: normalizedName, classification } as const;
    submitting.current = true;
    setPending(true);
    setNotice(null);
    try {
      const receipt = await registerCaseDocument(
        caseId,
        input,
        attempt.current!.keyFor(documentRegistrationFingerprint(input)),
      );
      const detail = await getCaseDocument(caseId, receipt.id);
      if (detail.document.record_version !== receipt.record_version) throw new TypeError("Document authority mismatch.");
      const authoritative = await listCaseDocuments(caseId);
      const created = authoritative.documents.find((document) => document.id === receipt.id);
      if (!created || created.record_version !== receipt.record_version) throw new TypeError("Document list authority mismatch.");
      if (!mounted.current) return;
      attempt.current!.complete();
      setDocuments(authoritative.documents);
      setDisplayName("");
      setClassification("identity_and_case_evidence");
      setNotice("success");
      queueMicrotask(() => nameInput.current?.focus());
    } catch (error) {
      if (!mounted.current) return;
      const failure = classifyDocumentFailure(error);
      if (failure !== "unavailable") attempt.current!.rotate();
      setNotice(
        failure === "validation" ? "validation"
          : failure === "conflict" || failure === "stale" ? "conflict"
            : failure === "forbidden" || failure === "unauthenticated" || failure === "not_found" ? "denied"
              : "unavailable",
      );
    } finally {
      submitting.current = false;
      if (mounted.current) setPending(false);
    }
  }

  return (
    <div className="ui-stack">
    <Card id="documents" title="案件文件" editing={editing} aria-busy={state === "loading"}
      action={state === "ready" && canCreate ? <Button variant="text" disabled={pending} onClick={() => setEditing(!editing)}>{t(editing ? 'ui.cancel' : 'caseUi.registerDocument')}</Button> : undefined}>

      {state === "loading" ? <CaseDocumentState title="正在載入案件文件" detail="請稍候。" /> : null}
      {state === "unauthenticated" ? <CaseDocumentState title="工作階段已失效" detail="請重新登入後查看案件文件。" login /> : null}
      {state === "denied" ? <CaseDocumentState title="無法查看案件文件" detail="目前帳號不能查看本案文件。" /> : null}
      {state === "unavailable" ? <CaseDocumentState title="文件服務暫時不可用" detail="請稍後重試。" onRetry={() => void load()} /> : null}

      {state === "ready" && canCreate && editing ? (
        <div className="ui-stack">
          <div>
            <h4 className="ui-value">登記文件</h4>
            <p className="ui-muted">登記文件名稱和儲存分類。</p>
          </div>
          <form className="grid grid-cols-1 md:grid-cols-2 gap-4" onSubmit={submit} aria-busy={pending}>
            <label className="ui-field">文件名稱<FieldInput ref={nameInput} value={displayName} maxLength={200} required disabled={pending} autoComplete="off" onChange={(event) => { draftChanged(); setDisplayName(event.target.value); }} /></label>
            <label className="ui-field">文件分類<FieldSelect aria-label="文件分類" value={classification} required disabled={pending} onChange={(event) => { draftChanged(); setClassification(event.target.value as DocumentClassification); }}>{DOCUMENT_CLASSIFICATIONS.map((value) => <option value={value} key={value}>{classificationLabel(value)}</option>)}</FieldSelect></label>
            <div className="md:col-span-2 flex flex-wrap justify-end gap-2">
              <Button type="button" variant="weak" disabled={pending || (displayName === "" && classification === "identity_and_case_evidence")} onClick={clearDraft}>清除</Button>
              <Button type="submit" variant="primary" disabled={pending} aria-busy={pending}><Icon name={pending ? "clock" : "plus"} size={15} />{pending ? "正在登記" : "登記文件"}</Button>
            </div>
          </form>

        </div>
      ) : null}

      {state === "ready" && documents.length === 0 ? <CaseDocumentState title="本案目前沒有文件" detail="登記後的文件會顯示在這裡。" /> : null}
      <RegistrationNotice notice={notice} />
    </Card>
      {state === "ready" ? documents.map(document => (
        <CaseDocumentCard key={document.id} document={document}>
          <DocumentTransferControls
            caseId={caseId}
            document={document}
            canUpload={canUpload}
            canDownload={canDownload}
            onAuthoritativeChange={updateAuthoritativeDocument}
          />
          <DocumentLifecycleControls caseId={caseId} document={document} onAuthoritativeChange={updateAuthoritativeDocument} />
        </CaseDocumentCard>
      )) : null}
    </div>
  );
}

function RegistrationNotice({ notice }: { readonly notice: Notice }) {
  if (notice === null) return null;
  const message = notice === "success" ? "文件已登記，案件文件已重新載入。"
    : notice === "validation" ? "請填寫 1 至 200 個字的文件名稱，並選擇文件分類。"
      : notice === "conflict" ? "目前案件狀態或本次登記內容有衝突，請重新確認。"
        : notice === "denied" ? "目前帳號不能在本案登記文件。"
          : "結果暫時無法確認，請稍後重試；重試不會重複登記。";
  return <Notice warning={notice !== "success"}><Icon name={notice === "success" ? "check-circle" : "x"} size={15} /><span>{message}</span></Notice>;
}

function CaseDocumentState({ title, detail, login, onRetry }: { title: string; detail: string; login?: boolean; onRetry?: () => void }) {
  return <Empty title={title} detail={detail} action={login ? <a href="/login" className="ui-button ui-secondary">重新登入</a> : onRetry ? <Button onClick={onRetry}>重新載入</Button> : undefined} />;
}
