'use client';

import { useTranslation } from 'react-i18next';
import { RouteTabs } from '@/components/ui/standard';

export type CasePageSection = 'overview' | 'assessment' | 'applications' | 'interviews' | 'documents';

export function CasePageTabs({ caseId, current = 'overview' }: { caseId: string; current?: CasePageSection }) {
  const { t } = useTranslation();
  const base = `/cases/${caseId}`;
  return <RouteTabs label={t('caseUi.sections')} items={[
    { href: base, label: t('caseUi.overview'), current: current === 'overview' },
    { href: `${base}/assessment`, label: t('caseUi.assessment'), current: current === 'assessment' },
    { href: `${base}/applications`, label: t('caseUi.applications'), current: current === 'applications' },
    { href: `${base}/interviews`, label: t('caseUi.interviews'), current: current === 'interviews' },
    { href: `${base}/documents`, label: t('caseUi.documents'), current: current === 'documents' },
  ]} />;
}
