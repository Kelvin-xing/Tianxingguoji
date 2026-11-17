"use client";

import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Card, DataList, FilledData, Tag } from '@/components/ui/standard';
import { CaseSystemDataEntry } from '@/components/cases/CaseSystemData';
import type { DocumentListItem } from '@/modules/documents/client';
import { documentVersionTone, classificationLabel, lifecycleLabel, versionStateLabel, formatDocumentDate } from './document-ui';

export function CaseDocumentCard({ document, children }: { document: DocumentListItem; children: ReactNode }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  return <>
    <Card title={document.display_name} editing={editing} action={<Button variant="text" onClick={() => setEditing(!editing)}>{t(editing ? 'ui.cancel' : 'caseUi.documentActions')}</Button>}>
      <div className="ui-actions"><Tag>{lifecycleLabel(document.lifecycle_state)}</Tag><Tag tone={documentVersionTone(document.latest_version_state)}>{versionStateLabel(document.latest_version_state)}</Tag></div>
      <FilledData missingLabel={count => t('caseUi.missing', { count })} items={[
        { label: t('caseUi.documentClassification'), value: classificationLabel(document.classification), filled: Boolean(document.classification) },
        { label: t('caseUi.updatedAt'), value: formatDocumentDate(document.updated_at), filled: Boolean(document.updated_at) },
      ]} />
      <div hidden={!editing}>{children}</div>
    </Card>
    <CaseSystemDataEntry><strong>{document.display_name}</strong><DataList items={[
      { label: t('caseUi.documentId'), value: document.id },
      { label: t('caseUi.documentVersion'), value: document.record_version },
    ]} /></CaseSystemDataEntry>
  </>;
}
