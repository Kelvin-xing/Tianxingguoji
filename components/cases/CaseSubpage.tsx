"use client";

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { getCase } from '@/modules/cases/client';
import { DataList, Notice } from '@/components/ui/standard';
import { CaseHeader, type CaseHeaderRecord } from './CaseHeader';
import { CasePageTabs, type CasePageSection } from './CasePageTabs';
import { CaseSystemDataEntry, CaseSystemDataProvider } from './CaseSystemData';

export function CaseSubpage({ caseId, current, record, children }: {
  caseId: string;
  current: Exclude<CasePageSection, 'overview'>;
  record?: CaseHeaderRecord & { readonly recordVersion: number };
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<(CaseHeaderRecord & { readonly recordVersion: number }) | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    if (record) return;
    const controller = new AbortController();
    getCase(caseId, controller.signal).then(value => {
      if (!controller.signal.aborted) setLoaded(value);
    }).catch(() => {
      if (!controller.signal.aborted) setUnavailable(true);
    });
    return () => controller.abort();
  }, [caseId, record]);
  const header = record ?? loaded;
  return <CaseSystemDataProvider>
    <Link href="/cases" className="ui-link">{t('caseUi.backToCases')}</Link>
    {header ? <CaseHeader record={header} /> : <Notice warning={unavailable}>{t(unavailable ? 'caseUi.headerUnavailable' : 'caseUi.headerLoading')}</Notice>}
    <CasePageTabs caseId={caseId} current={current} />
    {children}
    {header ? <CaseSystemDataEntry><DataList items={[{ label: t('caseUi.caseVersion'), value: header.recordVersion }]} /></CaseSystemDataEntry> : null}
  </CaseSystemDataProvider>;
}
