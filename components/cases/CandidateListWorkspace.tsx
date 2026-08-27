"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { Icon } from "@/components/workspace/Icon";
import {
  CandidateListIdempotencyAttempt,
  classifyCandidateListFailure,
  createCandidateList,
  getGuardianConfirmationOptions,
  listCandidateLists,
  listCandidateSchoolOptions,
  recordGuardianCandidateListDecision,
  reviewCandidateList,
  type CandidateListFailure,
  type CandidateListGuardianReceipt,
  type CandidateListReceipt,
  type CandidateListVersion,
  type CandidateSchoolOption,
  type FounderDecision,
  type GuardianChannel,
  type GuardianConfirmationOption,
  type GuardianDecision,
} from "./candidate-list-client";

type ReadState = "loading" | "ready" | "empty" | "denied" | "unavailable";
type SupportingState = "idle" | "loading" | "ready" | "denied" | "unavailable";
type CommandFeedback = Readonly<{
  kind: "success" | "stale" | "validation" | "conflict" | "denied" | "unavailable";
  message: string;
}> | null;

interface CandidateListWorkspaceProps {
  readonly caseId: string;
  readonly initialCaseRecordVersion: number;
  readonly initialCaseStage: string;
  readonly initialWorkflowStatus: string;
  readonly selectionReady: boolean;
  readonly canManageCandidateLists: boolean;
  readonly canReviewCandidateLists: boolean;
}

export function CandidateListWorkspace({
  caseId,
  initialCaseRecordVersion,
  initialCaseStage,
  initialWorkflowStatus,
  selectionReady,
  canManageCandidateLists,
  canReviewCandidateLists,
}: CandidateListWorkspaceProps) {
  const router = useRouter();
  const mounted = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const createAttempt = useRef(new CandidateListIdempotencyAttempt());
  const [readState, setReadState] = useState<ReadState>("loading");
  const [schoolState, setSchoolState] = useState<SupportingState>("loading");
  const [guardianState, setGuardianState] = useState<SupportingState>(
    canManageCandidateLists ? "loading" : "idle",
  );
  const [versions, setVersions] = useState<readonly CandidateListVersion[]>([]);
  const [schools, setSchools] = useState<readonly CandidateSchoolOption[]>([]);
  const [guardians, setGuardians] = useState<readonly GuardianConfirmationOption[]>([]);
  const [selectedSchoolIds, setSelectedSchoolIds] = useState<readonly string[]>([]);
  const [applicationDeadlines, setApplicationDeadlines] = useState<Readonly<Record<string, string>>>({});
  const [applicationDeadlineRisks, setApplicationDeadlineRisks] = useState<Readonly<Record<string, boolean>>>({});
  const [schoolQuery, setSchoolQuery] = useState("");
  const [changeSummary, setChangeSummary] = useState("");
  const [creating, setCreating] = useState(false);
  const [writeDenied, setWriteDenied] = useState(false);
  const [feedback, setFeedback] = useState<CommandFeedback>(null);

  const applyCandidateLists = useCallback((items: readonly CandidateListVersion[]) => {
    setVersions(items);
    setReadState(items.length > 0 ? "ready" : "empty");
  }, []);

  const load = useCallback(async () => {
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    setReadState("loading");
    setSchoolState("loading");
    if (canManageCandidateLists) setGuardianState("loading");

    const [listsResult, schoolsResult, guardiansResult] = await Promise.allSettled([
      listCandidateLists(caseId, nextController.signal),
      listCandidateSchoolOptions(nextController.signal),
      canManageCandidateLists
        ? getGuardianConfirmationOptions(caseId, nextController.signal)
        : Promise.resolve(Object.freeze([] as GuardianConfirmationOption[])),
    ]);
    if (!mounted.current || nextController.signal.aborted) return;

    if (listsResult.status === "fulfilled") {
      applyCandidateLists(listsResult.value.items);
    } else {
      const failure = classifyCandidateListFailure(listsResult.reason);
      setVersions([]);
      if (failure === "unauthenticated") {
        router.replace("/login");
      }
      setReadState(failure === "denied" || failure === "unauthenticated" ? "denied" : "unavailable");
    }

    if (schoolsResult.status === "fulfilled") {
      setSchools(schoolsResult.value);
      setSchoolState("ready");
    } else {
      setSchools([]);
      const failure = classifyCandidateListFailure(schoolsResult.reason);
      setSchoolState(failure === "denied" || failure === "unauthenticated" ? "denied" : "unavailable");
    }

    if (canManageCandidateLists) {
      if (guardiansResult.status === "fulfilled") {
        setGuardians(guardiansResult.value);
        setGuardianState("ready");
      } else {
        setGuardians([]);
        const failure = classifyCandidateListFailure(guardiansResult.reason);
        setGuardianState(failure === "denied" || failure === "unauthenticated" ? "denied" : "unavailable");
      }
    }
    if (controller.current === nextController) controller.current = null;
  }, [applyCandidateLists, canManageCandidateLists, caseId, router]);

  useEffect(() => {
    mounted.current = true;
    queueMicrotask(() => { if (mounted.current) void load(); });
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, [load]);

  const latestVersion = versions[0] ?? null;
  const hasDecisionPending = latestVersion?.status === "submitted" || latestVersion?.status === "awaiting_guardian";
  const advisorAuthorized = canManageCandidateLists && guardianState === "ready" && !writeDenied;
  const canCreateVersion = advisorAuthorized && schoolState === "ready" && selectionReady &&
    initialWorkflowStatus === "active" && initialCaseStage === "background_collection" && !hasDecisionPending;
  const selectedDeadlinesValid = selectedSchoolIds.length > 0 && selectedSchoolIds.every(
    (schoolId) => validLocalDateTime(applicationDeadlines[schoolId]),
  );
  const filteredSchools = useMemo(() => {
    const query = schoolQuery.trim().toLocaleLowerCase("zh-HK");
    return query.length === 0
      ? schools
      : schools.filter((school) => school.display_name.toLocaleLowerCase("zh-HK").includes(query));
  }, [schoolQuery, schools]);
  const schoolNames = useMemo(
    () => new Map(schools.map((school) => [school.school_id, school.display_name])),
    [schools],
  );

  async function createVersion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canCreateVersion || creating) return;
    const summary = changeSummary.trim();
    const chosen = selectedSchoolIds
      .map((id) => schools.find((school) => school.school_id === id))
      .filter((school): school is CandidateSchoolOption => school !== undefined);
    if (summary.length < 1 || summary.length > 1000 || chosen.length < 1 ||
        chosen.length > 50 || !selectedDeadlinesValid) {
      setFeedback({ kind: "validation", message: "請選擇 1 至 50 所學校、逐校填寫有效截止時間，並填寫 1 至 1000 字的變更摘要。" });
      return;
    }
    const input = {
      previous_version_id: latestVersion?.id ?? null,
      expected_case_record_version: initialCaseRecordVersion,
      change_summary: summary,
      items: chosen.map((school, index) => ({
        school_id: school.school_id,
        pinned_resolved_revision_id: school.resolved_revision_id,
        pinned_resolution_sha256: school.resolution_sha256,
        ordinal: index + 1,
        application_deadline: new Date(applicationDeadlines[school.school_id]!).toISOString(),
      })),
    } as const;
    setCreating(true);
    setFeedback(null);
    try {
      const receipt = await createCandidateList(
        caseId,
        input,
        createAttempt.current.keyFor(JSON.stringify(input)),
      );
      await reloadAfterCommand(receipt);
      createAttempt.current.complete();
      setSelectedSchoolIds([]);
      setApplicationDeadlines({});
      setApplicationDeadlineRisks({});
      setChangeSummary("");
      setFeedback({ kind: "success", message: "候選學校名單已提交，最新版本已重新載入。" });
    } catch (error: unknown) {
      await handleCommandFailure(error);
    } finally {
      setCreating(false);
    }
  }

  async function reloadAfterCommand(receipt: CandidateListReceipt): Promise<void> {
    const authoritative = await listCandidateLists(caseId);
    const saved = authoritative.items.find((version) => version.id === receipt.id);
    if (!saved || saved.record_version !== receipt.record_version) {
      throw new TypeError("CandidateList receipt does not match authoritative read.");
    }
    applyCandidateLists(authoritative.items);
    router.refresh();
  }

  async function reloadAfterGuardianDecision(receipt: CandidateListGuardianReceipt): Promise<void> {
    await reloadAfterCommand(receipt);
    setFeedback(receipt.automation.application_tasks === "pending"
      ? { kind: "success", message: "確認已保存，申請 Task 待自動恢復。" }
      : { kind: "success", message: `確認已保存，已自動生成 ${receipt.automation.provisioned_count} 項申請 Task。` });
  }

  async function handleCommandFailure(error: unknown): Promise<void> {
    const failure = classifyCandidateListFailure(error);
    if (failure === "stale" || failure === "conflict") {
      try {
        const authoritative = await listCandidateLists(caseId);
        applyCandidateLists(authoritative.items);
        router.refresh();
      } catch {
        setFeedback({ kind: "unavailable", message: "目前無法重新載入最新名單，草稿已保留。" });
        return;
      }
    }
    if (failure === "denied" || failure === "unauthenticated") setWriteDenied(true);
    setFeedback(feedbackForFailure(failure));
  }

  function toggleSchool(schoolId: string) {
    setSelectedSchoolIds((current) => current.includes(schoolId)
      ? current.filter((id) => id !== schoolId)
      : current.length >= 50 ? current : [...current, schoolId]);
    setFeedback(null);
  }

  function setApplicationDeadline(schoolId: string, value: string) {
    setApplicationDeadlines((current) => ({ ...current, [schoolId]: value }));
    setApplicationDeadlineRisks((current) => ({
      ...current,
      [schoolId]: validLocalDateTime(value) && new Date(value).valueOf() < Date.now(),
    }));
    setFeedback(null);
  }

  if (readState === "loading") {
    return <CandidateListState busy title="正在載入候選學校名單" detail="正在讀取版本及確認記錄。" />;
  }
  if (readState === "denied") {
    return <CandidateListState title="候選學校名單為只讀" detail="目前身份沒有查看此案件選校版本的權限。" />;
  }
  if (readState === "unavailable") {
    return (
      <CandidateListState title="候選學校名單暫時不可用" detail="已保存的版本不受影響。">
        <button type="button" className="secondary-button mt-3" onClick={() => void load()}>
          <Icon name="rotate-ccw" size={15} />重新載入
        </button>
      </CandidateListState>
    );
  }

  return (
    <section className="workspace-section" aria-labelledby="candidate-lists-title" aria-busy={creating}>
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id="candidate-lists-title" className="section-title">候選學校名單</h3>
          <p className="section-detail">{versions.length} 個版本 · Case v{initialCaseRecordVersion}</p>
        </div>
        <button type="button" className="secondary-button shrink-0" onClick={() => void load()}>
          <Icon name="rotate-ccw" size={15} />重新載入
        </button>
      </div>

      {feedback ? <FeedbackNotice feedback={feedback} /> : null}
      {writeDenied ? (
        <div className="inline-callout mt-4" role="status">
          <Icon name="shield" size={15} /><span>目前以只讀方式顯示；服務端未授予這項操作。</span>
        </div>
      ) : null}
      {canManageCandidateLists && guardianState === "loading" ? (
        <div className="inline-callout mt-4"><Icon name="clock" size={15} /><span>正在確認 Primary Advisor 操作範圍。</span></div>
      ) : null}
      {canManageCandidateLists && (guardianState === "denied" || guardianState === "unavailable") ? (
        <div className="inline-callout mt-4" role="status">
          <Icon name="shield" size={15} /><span>名單可查看；Primary Advisor 操作目前不可用。</span>
        </div>
      ) : null}
      {schoolState === "denied" || schoolState === "unavailable" ? (
        <div className="inline-callout mt-4" role="status">
          <Icon name="shield" size={15} /><span>學校選項暫時不可用；既有名單仍以只讀方式顯示。</span>
        </div>
      ) : null}

      {canCreateVersion ? (
        <form className="mt-5 border-t pt-5 space-y-4" style={{ borderColor: "var(--border)" }} onSubmit={createVersion}>
          <div>
            <h4 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>建立新版本</h4>
            <p className="section-detail">前一版本：{latestVersion ? `v${latestVersion.version_number}` : "無"}</p>
          </div>
          <label className="block text-sm font-medium" htmlFor="candidate-list-change-summary">
            變更摘要
            <textarea
              id="candidate-list-change-summary"
              className="assessment-control mt-1 min-h-20 w-full"
              value={changeSummary}
              minLength={1}
              maxLength={1000}
              required
              disabled={creating}
              onChange={(event) => { setChangeSummary(event.target.value); setFeedback(null); }}
            />
          </label>
          <div>
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
              <label className="block min-w-0 flex-1 text-sm font-medium" htmlFor="candidate-school-search">
                學校
                <input
                  id="candidate-school-search"
                  type="search"
                  className="assessment-control mt-1 w-full"
                  value={schoolQuery}
                  placeholder="搜尋學校"
                  onChange={(event) => setSchoolQuery(event.target.value)}
                />
              </label>
              <span className="status-pill shrink-0">已選 {selectedSchoolIds.length} / 50</span>
            </div>
            {schoolState === "ready" && schools.length === 0 ? (
              <div className="empty-state mt-3">目前沒有可選學校。</div>
            ) : (
              <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2 max-h-72 overflow-y-auto" role="group" aria-label="候選學校">
                {filteredSchools.map((school) => {
                  const selected = selectedSchoolIds.includes(school.school_id);
                  const deadline = applicationDeadlines[school.school_id] ?? "";
                  const overdue = applicationDeadlineRisks[school.school_id] === true;
                  return (
                    <div key={school.school_id} className="min-w-0">
                      <label className={`selection-card ${selected ? "selected" : ""}`}>
                        <input
                          type="checkbox"
                          checked={selected}
                          disabled={creating || (!selected && selectedSchoolIds.length >= 50)}
                          onChange={() => toggleSchool(school.school_id)}
                        />
                        <span className="selection-mark" aria-hidden="true" />
                        <span className="min-w-0"><strong>{school.display_name}</strong><small>Resolved revision 已固定</small></span>
                      </label>
                      {selected ? (
                        <label className="mt-2 block text-xs font-medium" htmlFor={`application-deadline-${school.school_id}`}>
                          申請截止時間
                          <input
                            id={`application-deadline-${school.school_id}`}
                            type="datetime-local"
                            className="assessment-control mt-1 w-full"
                            value={deadline}
                            required
                            disabled={creating}
                            aria-describedby={overdue ? `application-deadline-risk-${school.school_id}` : undefined}
                            onChange={(event) => setApplicationDeadline(school.school_id, event.target.value)}
                          />
                          {overdue ? (
                            <span
                              id={`application-deadline-risk-${school.school_id}`}
                              className="mt-1 block"
                              style={{ color: "#991b1b" }}
                            >
                              已逾期風險
                            </span>
                          ) : null}
                        </label>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              className="primary-button justify-center min-w-36"
              disabled={creating || !selectedDeadlinesValid || changeSummary.trim().length < 1}
            >
              <Icon name={creating ? "clock" : "arrow-right"} size={15} />
              {creating ? "提交中…" : "提交新版本"}
            </button>
          </div>
        </form>
      ) : null}

      {readState === "empty" ? (
        <div className="empty-state mt-5" aria-live="polite">
          <Icon name="clipboard" size={20} /><strong>尚未建立候選名單</strong><span>目前沒有可顯示的選校版本。</span>
        </div>
      ) : (
        <div className="mt-5 border-t" style={{ borderColor: "var(--border)" }}>
          {versions.map((version) => (
            <CandidateListVersionView
              key={version.id}
              version={version}
              caseId={caseId}
              caseRecordVersion={initialCaseRecordVersion}
              schoolNames={schoolNames}
              guardians={guardians}
              canReview={canReviewCandidateLists && !writeDenied}
              canRecordGuardian={advisorAuthorized}
              onSaved={reloadAfterCommand}
              onGuardianSaved={reloadAfterGuardianDecision}
              onFailure={handleCommandFailure}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function CandidateListVersionView({
  version,
  caseId,
  caseRecordVersion,
  schoolNames,
  guardians,
  canReview,
  canRecordGuardian,
  onSaved,
  onGuardianSaved,
  onFailure,
}: {
  readonly version: CandidateListVersion;
  readonly caseId: string;
  readonly caseRecordVersion: number;
  readonly schoolNames: ReadonlyMap<string, string>;
  readonly guardians: readonly GuardianConfirmationOption[];
  readonly canReview: boolean;
  readonly canRecordGuardian: boolean;
  readonly onSaved: (receipt: CandidateListReceipt) => Promise<void>;
  readonly onGuardianSaved: (receipt: CandidateListGuardianReceipt) => Promise<void>;
  readonly onFailure: (error: unknown) => Promise<void>;
}) {
  return (
    <article className="py-5 border-b last:border-b-0" style={{ borderColor: "var(--border)" }}>
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>版本 {version.version_number}</h4>
            <span className={`status-pill ${statusTone(version.status)}`}>{statusLabel(version.status)}</span>
            <span className="status-pill">記錄 v{version.record_version}</span>
          </div>
          <p className="mt-2 text-sm break-words" style={{ color: "var(--text-secondary)" }}>{version.change_summary}</p>
        </div>
        <time className="text-xs shrink-0" dateTime={version.created_at} style={{ color: "var(--text-muted)" }}>
          {formatDateTime(version.created_at)}
        </time>
      </div>

      <ol className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-x-5 gap-y-2" aria-label={`版本 ${version.version_number} 學校`}>
        {version.items.map((item) => (
          <li key={item.id} className="flex min-w-0 items-start gap-2 text-sm">
            <span className="text-xs tabular-nums mt-0.5" style={{ color: "var(--text-muted)" }}>{item.ordinal}.</span>
            <span className="min-w-0 break-words" style={{ color: "var(--text-primary)" }}>
              <span className="block">{schoolNames.get(item.school_id) ?? `學校 ${item.school_id}`}</span>
              <span className="mt-1 block text-xs" style={{ color: "var(--text-muted)" }}>
                截止：{item.application_deadline ? formatDateTime(item.application_deadline) : "未記錄（歷史版本）"}
              </span>
            </span>
          </li>
        ))}
      </ol>

      <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4 border-t pt-4" style={{ borderColor: "var(--border-subtle)" }}>
        <DecisionSummary
          title="Founder 決定"
          value={version.founder_approval
            ? `${version.founder_approval.decision === "approved" ? "批准" : "駁回"} · ${version.founder_approval.reason}`
            : "待決定"}
          timestamp={version.founder_approval?.decided_at ?? null}
        />
        <DecisionSummary
          title="Guardian 決定"
          value={version.guardian_decision
            ? `${version.guardian_decision.decision === "confirmed" ? "已確認" : "未確認"} · ${channelLabel(version.guardian_decision.channel)}`
            : "待決定"}
          timestamp={version.guardian_decision?.decided_at ?? null}
        />
      </div>

      {canReview && version.status === "submitted" ? (
        <FounderReviewForm version={version} caseId={caseId} onSaved={onSaved} onFailure={onFailure} />
      ) : null}
      {canRecordGuardian && version.status === "awaiting_guardian" &&
        version.founder_approval?.decision === "approved" ? (
          <GuardianDecisionForm
            version={version}
            caseId={caseId}
            caseRecordVersion={caseRecordVersion}
            guardians={guardians}
            onSaved={onGuardianSaved}
            onFailure={onFailure}
          />
        ) : null}
    </article>
  );
}

function FounderReviewForm({
  version,
  caseId,
  onSaved,
  onFailure,
}: {
  readonly version: CandidateListVersion;
  readonly caseId: string;
  readonly onSaved: (receipt: CandidateListReceipt) => Promise<void>;
  readonly onFailure: (error: unknown) => Promise<void>;
}) {
  const attempt = useRef(new CandidateListIdempotencyAttempt());
  const [decision, setDecision] = useState<FounderDecision>("approved");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedReason = reason.trim();
    if (pending || normalizedReason.length < 1 || normalizedReason.length > 1000) return;
    const input = { decision, expected_record_version: version.record_version, reason: normalizedReason } as const;
    setPending(true);
    try {
      const receipt = await reviewCandidateList(
        caseId,
        version.id,
        input,
        attempt.current.keyFor(JSON.stringify(input)),
      );
      await onSaved(receipt);
      attempt.current.complete();
      setReason("");
    } catch (error: unknown) {
      await onFailure(error);
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="mt-5 border-t pt-4 space-y-3" style={{ borderColor: "var(--border-subtle)" }} onSubmit={submit}>
      <fieldset disabled={pending}>
        <legend className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Founder 審核</legend>
        <div className="mt-2 flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-sm"><input type="radio" name={`founder-${version.id}`} value="approved" checked={decision === "approved"} onChange={() => setDecision("approved")} />批准</label>
          <label className="flex items-center gap-2 text-sm"><input type="radio" name={`founder-${version.id}`} value="rejected" checked={decision === "rejected"} onChange={() => setDecision("rejected")} />駁回修改</label>
        </div>
      </fieldset>
      <label className="block text-sm font-medium" htmlFor={`founder-reason-${version.id}`}>
        原因
        <textarea id={`founder-reason-${version.id}`} className="assessment-control mt-1 min-h-20 w-full" value={reason} minLength={1} maxLength={1000} required disabled={pending} onChange={(event) => setReason(event.target.value)} />
      </label>
      <div className="flex justify-end"><button type="submit" className="primary-button justify-center min-w-32" disabled={pending || reason.trim().length < 1}><Icon name={pending ? "clock" : "check"} size={15} />{pending ? "提交中…" : "提交審核"}</button></div>
    </form>
  );
}

function GuardianDecisionForm({
  version,
  caseId,
  caseRecordVersion,
  guardians,
  onSaved,
  onFailure,
}: {
  readonly version: CandidateListVersion;
  readonly caseId: string;
  readonly caseRecordVersion: number;
  readonly guardians: readonly GuardianConfirmationOption[];
  readonly onSaved: (receipt: CandidateListGuardianReceipt) => Promise<void>;
  readonly onFailure: (error: unknown) => Promise<void>;
}) {
  const attempt = useRef(new CandidateListIdempotencyAttempt());
  const [relationshipId, setRelationshipId] = useState(guardians[0]?.guardian_relationship_id ?? "");
  const [decision, setDecision] = useState<GuardianDecision>("confirmed");
  const [channel, setChannel] = useState<GuardianChannel>("phone");
  const [decidedAt, setDecidedAt] = useState(() => toLocalDateTime(new Date()));
  const [pending, setPending] = useState(false);
  const founderHash = version.founder_approval?.decision_sha256 ?? null;
  const selectedGuardian = guardians.find((guardian) => guardian.guardian_relationship_id === relationshipId);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !selectedGuardian || founderHash === null) return;
    const timestamp = new Date(decidedAt);
    if (!Number.isFinite(timestamp.valueOf()) || timestamp.valueOf() > Date.now()) return;
    const input = {
      bound_founder_decision_sha256: founderHash,
      channel,
      decision,
      expected_case_record_version: caseRecordVersion,
      expected_list_record_version: version.record_version,
      guardian_decided_at: timestamp.toISOString(),
      guardian_id: selectedGuardian.guardian_id,
      guardian_relationship_id: selectedGuardian.guardian_relationship_id,
    } as const;
    setPending(true);
    try {
      const receipt = await recordGuardianCandidateListDecision(
        caseId,
        version.id,
        input,
        attempt.current.keyFor(JSON.stringify(input)),
      );
      await onSaved(receipt);
      attempt.current.complete();
    } catch (error: unknown) {
      await onFailure(error);
    } finally {
      setPending(false);
    }
  }

  if (guardians.length === 0) {
    return (
      <div className="inline-callout warning mt-5" role="status">
        <Icon name="users" size={15} /><span>目前沒有有效的 Guardian 關係可記錄確認。</span>
      </div>
    );
  }

  return (
    <form className="mt-5 border-t pt-4 space-y-3" style={{ borderColor: "var(--border-subtle)" }} onSubmit={submit}>
      <div><h5 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Guardian 線下確認</h5><p className="section-detail">Founder approval hash 已綁定此版本。</p></div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="block text-sm font-medium" htmlFor={`guardian-${version.id}`}>
          Guardian 關係
          <select id={`guardian-${version.id}`} className="assessment-control mt-1 w-full" value={relationshipId} disabled={pending} required onChange={(event) => setRelationshipId(event.target.value)}>
            {guardians.map((guardian) => <option key={guardian.guardian_relationship_id} value={guardian.guardian_relationship_id}>{guardian.display_name} · {relationshipLabel(guardian)}</option>)}
          </select>
        </label>
        <label className="block text-sm font-medium" htmlFor={`guardian-channel-${version.id}`}>
          渠道
          <select id={`guardian-channel-${version.id}`} className="assessment-control mt-1 w-full" value={channel} disabled={pending} onChange={(event) => setChannel(event.target.value as GuardianChannel)}><option value="phone">電話</option><option value="wechat">微信</option><option value="in_person">面談</option></select>
        </label>
        <label className="block text-sm font-medium" htmlFor={`guardian-decided-at-${version.id}`}>
          確認時間
          <input id={`guardian-decided-at-${version.id}`} type="datetime-local" className="assessment-control mt-1 w-full" value={decidedAt} max={toLocalDateTime(new Date())} required disabled={pending} onChange={(event) => setDecidedAt(event.target.value)} />
        </label>
        <fieldset disabled={pending}>
          <legend className="text-sm font-medium">決定</legend>
          <div className="mt-3 flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-sm"><input type="radio" name={`guardian-decision-${version.id}`} value="confirmed" checked={decision === "confirmed"} onChange={() => setDecision("confirmed")} />確認</label>
            <label className="flex items-center gap-2 text-sm"><input type="radio" name={`guardian-decision-${version.id}`} value="not_confirmed" checked={decision === "not_confirmed"} onChange={() => setDecision("not_confirmed")} />不確認</label>
          </div>
        </fieldset>
      </div>
      <div className="flex justify-end"><button type="submit" className="primary-button justify-center min-w-32" disabled={pending || !selectedGuardian || !decidedAt}><Icon name={pending ? "clock" : "check"} size={15} />{pending ? "提交中…" : "保存確認"}</button></div>
    </form>
  );
}

function DecisionSummary({ title, value, timestamp }: { readonly title: string; readonly value: string; readonly timestamp: string | null }) {
  return <div className="min-w-0"><div className="text-xs font-semibold" style={{ color: "var(--text-muted)" }}>{title}</div><div className="mt-1 text-sm break-words" style={{ color: "var(--text-primary)" }}>{value}</div>{timestamp ? <time className="mt-1 block text-xs" dateTime={timestamp} style={{ color: "var(--text-muted)" }}>{formatDateTime(timestamp)}</time> : null}</div>;
}

function CandidateListState({ busy = false, title, detail, children }: { readonly busy?: boolean; readonly title: string; readonly detail: string; readonly children?: ReactNode }) {
  return <section className="workspace-section" aria-busy={busy}><div className="empty-state"><Icon name={busy ? "clock" : "clipboard"} size={20} /><strong>{title}</strong><span>{detail}</span>{children}</div></section>;
}

function FeedbackNotice({ feedback }: { readonly feedback: NonNullable<CommandFeedback> }) {
  return <div className={`inline-callout mt-4 ${feedback.kind === "success" ? "" : "warning"}`} role={feedback.kind === "success" ? "status" : "alert"}><Icon name={feedback.kind === "success" ? "check-circle" : "activity"} size={15} /><span>{feedback.message}</span></div>;
}

function feedbackForFailure(failure: CandidateListFailure): NonNullable<CommandFeedback> {
  if (failure === "stale") return { kind: "stale", message: "版本已被其他人更新，已重新載入最新名單。" };
  if (failure === "validation") return { kind: "validation", message: "提交內容未通過檢查，草稿已保留。" };
  if (failure === "conflict") return { kind: "conflict", message: "目前案件或名單狀態不允許這項操作，已重新載入。" };
  if (failure === "denied" || failure === "unauthenticated") return { kind: "denied", message: "服務端未授予這項操作；目前改為只讀顯示。" };
  return { kind: "unavailable", message: "選校服務暫時不可用；重試會沿用同一冪等憑據。" };
}

function statusLabel(status: CandidateListVersion["status"]): string {
  if (status === "draft") return "草稿";
  if (status === "submitted") return "待 Founder 審核";
  if (status === "awaiting_guardian") return "待 Guardian 確認";
  if (status === "confirmed") return "已確認";
  return "已退回";
}

function statusTone(status: CandidateListVersion["status"]): string {
  if (status === "confirmed") return "status-success";
  if (status === "returned") return "status-danger";
  if (status === "submitted" || status === "awaiting_guardian") return "status-warning";
  return "";
}

function channelLabel(channel: GuardianChannel): string {
  if (channel === "phone") return "電話";
  if (channel === "wechat") return "微信";
  return "面談";
}

function relationshipLabel(guardian: GuardianConfirmationOption): string {
  const description = guardian.relationship_description ? ` · ${guardian.relationship_description}` : "";
  const primary = guardian.is_primary_contact ? " · 主要聯絡人" : "";
  const legal = guardian.is_legal_guardian ? " · 法定監護人" : "";
  return `${guardian.relationship_type}${description}${primary}${legal}`;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-HK", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Hong_Kong" }).format(new Date(value));
}

function toLocalDateTime(value: Date): string {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}

function validLocalDateTime(value: string | undefined): boolean {
  return typeof value === "string" && value.length > 0 && Number.isFinite(new Date(value).valueOf());
}
