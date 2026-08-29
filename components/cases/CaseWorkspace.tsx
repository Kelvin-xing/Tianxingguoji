"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { AssessmentEditor } from "@/components/cases/AssessmentEditor";
import { Icon, type IconName } from "@/components/workspace/Icon";

import {
  type CaseWorkspaceProjection,
  type CaseWorkspaceTab,
  type CaseWorkspaceTabProjection,
  type WorkspaceAction,
  type WorkspacePanelData,
  type WorkspacePanelState,
  type WorkspaceStatusTone,
  moveCaseWorkspaceTab,
  workspaceTabHref,
} from "./workspace-model";
import styles from "./CaseWorkspace.module.css";

const TAB_ICONS: Readonly<Record<CaseWorkspaceTab, IconName>> = {
  overview: "layout-dashboard",
  assessment: "clipboard",
  schools: "book-open",
  tasks: "check-circle",
  documents: "file-text",
  timeline: "activity",
};

export function CaseWorkspace({ projection }: { readonly projection: CaseWorkspaceProjection }) {
  const visibleTabs = projection.tabs.filter((tab) => tab.visible);
  const panelHeadingRef = useRef<HTMLHeadingElement>(null);
  const conflictHeadingRef = useRef<HTMLHeadingElement>(null);
  const [dismissedConflict, setDismissedConflict] = useState<typeof projection.conflict>(null);
  const [noticeState, setNoticeState] = useState<Readonly<{
    activeTab: CaseWorkspaceTab;
    message: string;
  }> | null>(null);
  const conflict = projection.conflict === dismissedConflict ? null : projection.conflict;
  const notice = noticeState?.activeTab === projection.activeTab ? noticeState.message : null;

  const focusActivePanel = useCallback(() => {
    const target = projection.activeTab === "assessment"
      ? document.getElementById("assessment-editor-title")
      : panelHeadingRef.current;
    if (target instanceof HTMLElement) target.focus();
  }, [projection.activeTab]);

  const dismissConflict = useCallback((message?: string) => {
    setDismissedConflict(conflict);
    if (message) setNoticeState({ activeTab: projection.activeTab, message });
    requestAnimationFrame(focusActivePanel);
  }, [conflict, focusActivePanel, projection.activeTab]);

  useEffect(() => {
    focusActivePanel();
  }, [focusActivePanel]);

  useEffect(() => {
    if (!conflict) return;
    conflictHeadingRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismissConflict();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [conflict, dismissConflict]);

  return (
    <div className={styles.workspace} data-testid="case-workspace">
      {projection.header ? <WorkspaceHeader header={projection.header} /> : null}
      {visibleTabs.length > 0 ? (
        <WorkspaceTabs
          routeBase={projection.routeBase}
          activeTab={projection.activeTab}
          tabs={visibleTabs}
        />
      ) : null}
      {notice ? <div className={styles.liveNotice} role="status"><Icon name="activity" size={15} />{notice}</div> : null}
      <WorkspacePanel panel={projection.panel} headingRef={panelHeadingRef} />
      {conflict ? (
        <section className={styles.dialogBackdrop} role="presentation">
          <div className={styles.conflictDialog} role="dialog" aria-modal="true" aria-labelledby="workspace-conflict-title">
            <div className={styles.dialogHeading}>
              <div className={styles.dialogIcon}><Icon name="clock" size={18} /></div>
              <div>
                <h2 id="workspace-conflict-title" ref={conflictHeadingRef} tabIndex={-1}>{conflict.title}</h2>
                <p>資料在更新前已經變更。</p>
              </div>
            </div>
            <dl className={styles.conflictValues}>
              <div><dt>目前版本</dt><dd>{conflict.currentSummary}</dd></div>
              <div><dt>你的草稿</dt><dd>{conflict.draftSummary}</dd></div>
            </dl>
            <p className={styles.conflictVersion}>最新資料版本：{conflict.currentVersion}</p>
            <div className={styles.dialogActions}>
              <button type="button" className="secondary-button" onClick={() => {
                dismissConflict("已採用最新資料。");
              }}>
                採用最新資料
              </button>
              <button type="button" className="secondary-button" onClick={() => {
                dismissConflict("草稿已保留，請檢查後再試。");
              }}>
                保留草稿
              </button>
              <Link href={conflict.retryHref} className="primary-button">以目前版本重試</Link>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function WorkspaceHeader({ header }: { readonly header: NonNullable<CaseWorkspaceProjection["header"]> }) {
  return (
    <header className={styles.caseHeader}>
      <div className={styles.breadcrumb} aria-label="頁面位置">
        <Link href="/cases">案件</Link><Icon name="chevron-right" size={14} /><span>{header.caseNumber}</span>
      </div>
      <div className={styles.caseHeaderContent}>
        <div className={styles.headerIdentity}>
          <div className={styles.stageLine}>
            <span className={styles.stagePill}>{header.stageLabel}</span>
            <span>{header.updatedLabel}</span>
          </div>
          <h1>{header.studentLabel}</h1>
          <p>{header.caseNumber} · {header.summary}</p>
        </div>
      </div>
    </header>
  );
}

function WorkspaceTabs({
  routeBase,
  activeTab,
  tabs,
}: {
  readonly routeBase: string;
  readonly activeTab: CaseWorkspaceTab;
  readonly tabs: readonly CaseWorkspaceProjection["tabs"][number][];
}) {
  const selectedTabRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    selectedTabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTab]);

  function onKeyDown(event: React.KeyboardEvent<HTMLAnchorElement>) {
    if (!(["ArrowLeft", "ArrowRight", "Home", "End"] as const).includes(event.key as "ArrowLeft")) return;
    event.preventDefault();
    const nextTab = moveCaseWorkspaceTab(activeTab, tabs, event.key as "ArrowLeft" | "ArrowRight" | "Home" | "End");
    const next = nextTab ? document.getElementById(`case-workspace-tab-${nextTab}`) as HTMLAnchorElement | null : null;
    next?.focus();
    next?.click();
  }

  return (
    <nav className={styles.tabScroller} aria-label="案件工作區分頁">
      <div className={styles.tabList} role="tablist" aria-orientation="horizontal">
        {tabs.map((tab) => {
          const selected = tab.id === activeTab;
          return (
            <Link
              key={tab.id}
              id={`case-workspace-tab-${tab.id}`}
              ref={selected ? selectedTabRef : null}
              href={workspaceTabHref(routeBase, tab.id)}
              role="tab"
              aria-selected={selected}
              aria-controls="case-workspace-panel"
              tabIndex={selected ? 0 : -1}
              className={`${styles.tab} ${selected ? styles.tabSelected : ""}`}
              onKeyDown={onKeyDown}
            >
              <Icon name={TAB_ICONS[tab.id]} size={15} />
              <span>{workspaceTabLabel(tab)}</span>
              {typeof tab.count === "number" ? <span className={styles.tabCount}>{tab.count}</span> : null}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

function WorkspacePanel({
  panel,
  headingRef,
}: {
  readonly panel: WorkspacePanelState;
  readonly headingRef: React.RefObject<HTMLHeadingElement | null>;
}) {
  if (panel.kind === "loading") {
    return <section id="case-workspace-panel" role="tabpanel" className={styles.panel} aria-busy="true"><div className={styles.loadingRows}><span /><span /><span /></div><span className="sr-only">正在載入案件工作區</span></section>;
  }
  if (panel.kind === "denied") {
    return <section id="case-workspace-panel" role="tabpanel" className={styles.panel}><SurfaceState icon="lock" title="目前無法使用此工作區" detail="目前帳號沒有查看此區域的權限。" headingRef={headingRef} /></section>;
  }
  if (panel.kind === "empty") {
    return <section id="case-workspace-panel" role="tabpanel" className={styles.panel}><SurfaceState icon="activity" title={panel.title} detail={panel.detail} action={panel.action} headingRef={headingRef} /></section>;
  }
  if (panel.kind === "error") {
    return <section id="case-workspace-panel" role="tabpanel" className={styles.panel}><SurfaceState icon="x" title={panel.title} detail={panel.detail} requestReference={panel.requestReference} retryHref={panel.retryHref} headingRef={headingRef} /></section>;
  }
  if (panel.data.tab === "assessment" && panel.data.editor) {
    return <div id="case-workspace-panel" role="tabpanel"><AssessmentEditor endpoint={panel.data.editor.endpoint} initialView={panel.data.editor.initialView} /></div>;
  }
  return <section id="case-workspace-panel" role="tabpanel" className={styles.panel}><ReadyPanel data={panel.data} headingRef={headingRef} /></section>;
}

function ReadyPanel({ data, headingRef }: { readonly data: WorkspacePanelData; readonly headingRef: React.RefObject<HTMLHeadingElement | null> }) {
  if (data.tab === "overview") {
    return (
      <>
        <PanelHeading headingRef={headingRef} title="案件概覽" detail="查看目前階段、待處理事項與下一個可用操作。" />
        <dl className={styles.factGrid}>{data.facts.map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>
        {data.blockers.length > 0 ? <div className={styles.blockers} role="status"><Icon name="clock" size={16} /><div><strong>需要處理</strong>{data.blockers.map((blocker) => <p key={blocker}>{blocker}</p>)}</div></div> : null}
        {data.nextAction ? <WorkspaceActionLink action={data.nextAction} className={styles.nextAction} /> : null}
      </>
    );
  }
  if (data.tab === "assessment") {
    return <SurfaceState icon="clipboard" title="評估已準備好" detail={data.answeredLabel} headingRef={headingRef} />;
  }
  if (data.tab === "timeline") {
    return (
      <>
        <PanelHeading headingRef={headingRef} title="案件時間軸" detail="顯示目前可查看的案件活動。" />
        <ol className={styles.timeline}>{data.events.map((event) => <li key={event.id}><span className={`${styles.timelineDot} ${toneClass(event.tone)}`} /><div><strong>{event.title}</strong><p>{event.detail}</p></div><time>{event.occurredLabel}</time></li>)}</ol>
      </>
    );
  }
  const title = data.tab === "schools" ? "學校" : data.tab === "tasks" ? "任務" : "文件";
  const detail = data.tab === "schools" ? "查看已確認的學校目標及目前狀態。" : data.tab === "tasks" ? "查看已指派的工作及處理狀態。" : "查看可用的文件版本及檢查狀態。";
  return (
    <>
      <div className={styles.panelTopline}><PanelHeading headingRef={headingRef} title={title} detail={detail} /><WorkspaceActionLink action={data.action} /></div>
      <ul className={styles.rowList}>{data.rows.map((row) => <li key={row.id}><div className={styles.rowIcon}><Icon name={data.tab === "schools" ? "book-open" : data.tab === "tasks" ? "clipboard" : "file-text"} size={16} /></div><div className={styles.rowCopy}><strong>{row.title}</strong><p>{row.detail}</p></div>{row.statusLabel ? <span className={`${styles.rowStatus} ${toneClass(row.statusTone ?? "neutral")}`}>{row.statusLabel}</span> : null}{row.meta ? <span className={styles.rowMeta}>{row.meta}</span> : null}</li>)}</ul>
    </>
  );
}

function SurfaceState({
  icon,
  title,
  detail,
  action,
  requestReference,
  retryHref,
  headingRef,
}: {
  readonly icon: IconName;
  readonly title: string;
  readonly detail: string;
  readonly action?: WorkspaceAction | null;
  readonly requestReference?: string;
  readonly retryHref?: string;
  readonly headingRef: React.RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <div className={styles.surfaceState}>
      <div className={styles.stateIcon}><Icon name={icon} size={20} /></div>
      <h2 ref={headingRef} tabIndex={-1}>{title}</h2>
      <p>{detail}</p>
      {requestReference ? <p className={styles.requestReference}>參考編號：{requestReference}</p> : null}
      <div className={styles.stateActions}>
        {action ? <WorkspaceActionLink action={action} /> : null}
        {retryHref ? <Link href={retryHref} className="secondary-button">重新載入</Link> : null}
      </div>
    </div>
  );
}

function PanelHeading({ title, detail, headingRef }: { readonly title: string; readonly detail: string; readonly headingRef: React.RefObject<HTMLHeadingElement | null> }) {
  return <div className={styles.panelHeading}><h2 ref={headingRef} tabIndex={-1}>{title}</h2><p>{detail}</p></div>;
}

function WorkspaceActionLink({ action, className }: { readonly action: WorkspaceAction | null; readonly className?: string }) {
  if (!action) return null;
  if (!action.href) return <span className={`${styles.unavailableAction} ${className ?? ""}`} title={action.unavailableLabel}>{action.label}</span>;
  return <Link href={action.href} className={`${className ?? ""} primary-button`}><Icon name="arrow-right" size={15} />{action.label}</Link>;
}

function toneClass(tone: WorkspaceStatusTone): string {
  return styles[`tone${tone[0].toUpperCase()}${tone.slice(1)}`] ?? styles.toneNeutral;
}

function workspaceTabLabel(tab: CaseWorkspaceTabProjection): string {
  const labels: Readonly<Record<CaseWorkspaceTab, string>> = {
    overview: "概覽",
    assessment: "評估",
    schools: "學校",
    tasks: "任務",
    documents: "文件",
    timeline: "時間軸",
  };
  return labels[tab.id];
}
