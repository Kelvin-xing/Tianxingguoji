"use client";

import { PageHeader, Tag } from '@/components/ui/standard';
import { casePersonName } from './case-person-name';

export interface CaseHeaderRecord {
  readonly studentName: string;
  readonly caseNumber: string;
  readonly intakeYear: number;
  readonly admissionType: string;
  readonly primaryBindingLabel: string;
  readonly stage: string;
}

/** Presentation only: callers retain their existing authoritative access checks. */
export function CaseHeader({ record }: { record: CaseHeaderRecord }) {
  const stages: Record<string, string> = { signed: '已簽約', background_collection: '背景資料', school_selection_confirmed: '選校確認', application_in_progress: '申請處理', closed: '已結案' };
  const admissions: Record<string, string> = { entry: '首次入學', s1_admission: 'S1 入學', transfer: '插班' };
  return <PageHeader title={`${record.studentName} · ${record.caseNumber}`}
    description={`K12 · ${record.intakeYear} · ${admissions[record.admissionType] ?? record.admissionType} · ${casePersonName(record.primaryBindingLabel)}`}>
    <Tag tone={record.stage === 'closed' ? 'neutral' : 'primary'}>{stages[record.stage] ?? record.stage}</Tag>
  </PageHeader>;
}
