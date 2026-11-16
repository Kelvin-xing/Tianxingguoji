'use client';

import { useTranslation } from 'react-i18next';
import { RouteTabs } from '@/components/ui/standard';

export function CasePageTabs({ caseId }: { caseId: string }) {
  const { t } = useTranslation();
  const base = `/cases/${caseId}`;
  return <RouteTabs label={t('caseUi.sections')} items={[
    { href: base, label: t('caseUi.overview'), current: true },
    { href: `${base}/assessment`, label: t('caseUi.assessment') },
    { href: `${base}/applications`, label: t('caseUi.applications') },
    { href: `${base}/interviews`, label: t('caseUi.interviews') },
    { href: `${base}/documents`, label: t('caseUi.documents') },
  ]} />;
}
