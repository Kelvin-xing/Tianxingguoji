import { promises as fs } from 'fs'
import path from 'path'
import type { AdmissionRecord, ConfidenceLevel, CrawlerReviewRecord, CrawlerSummary, ReviewStatus } from '@/types'

const SNAPSHOT_DIR = process.env.CRAWLER_SNAPSHOT_DIR || path.join(process.cwd(), 'data/crawler-source/latest')

async function readJsonFile<T>(fileName: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(path.join(SNAPSHOT_DIR, fileName), 'utf-8')
    return JSON.parse(raw) as T
  } catch (error) {
    console.error(`Failed to read crawler snapshot ${fileName}`, error)
    return fallback
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim()
}

function splitLines(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asString).filter(Boolean)
  return asString(value)
    .split(/\n+/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function confidence(value: unknown): ConfidenceLevel {
  const normalized = asString(value).toLowerCase()
  if (normalized === 'high' || normalized === 'medium' || normalized === 'low') return normalized
  return 'missing'
}

function reviewStatus(value: unknown): ReviewStatus {
  const normalized = asString(value).toLowerCase()
  if (
    normalized === 'approved' ||
    normalized === 'needs_review' ||
    normalized === 'rejected' ||
    normalized === 'auto_selected'
  ) {
    return normalized
  }
  return 'unknown'
}

export function normalizeSchool(raw: Record<string, unknown>): AdmissionRecord {
  const website = asString(raw.website || raw.official_website)
  return {
    school_key: asString(raw.school_key),
    school_name_zh: asString(raw.school_name_zh || raw.school_full_name),
    school_name_en: asString(raw.school_name_en),
    website,
    official_website: asString(raw.official_website) || website,
    final_admission_url: asString(raw.final_admission_url),
    admission_type: asString(raw.admission_type) === 's1_admission' ? 's1_admission' : asString(raw.admission_type) === 'transfer' ? 'transfer' : 'unknown',
    confidence: confidence(raw.confidence),
    application_dates: asString(raw.application_dates || raw.application_period || raw.application_open || raw.submission_deadline),
    application_open: asString(raw.application_open),
    application_period: asString(raw.application_period),
    submission_deadline: asString(raw.submission_deadline),
    exam_date: asString(raw.exam_date),
    interview_date: asString(raw.interview_date),
    result_notification_date: asString(raw.result_notification_date),
    required_materials: asString(raw.required_materials),
    application_form_links: splitLines(raw.application_form_links),
    evidence_urls: splitLines(raw.evidence_urls),
    review_status: reviewStatus(raw.review_status),
    notes: asString(raw.notes || raw.extraction_notes),
    district: asString(raw.district),
    school_level: asString(raw.school_level),
    school_type: asString(raw.school_type),
    finance_type: asString(raw.finance_type),
    address: asString(raw.address),
    phone: asString(raw.phone),
    tuition_info: asString(raw.tuition_info || raw.approved_course_and_tuition_info),
    dormitory_info: asString(raw.dormitory_info || raw.approved_classrooms_and_dormitory_capacity),
    is_sen: Boolean(raw.is_sen),
  }
}

export function normalizeReview(raw: Record<string, unknown>): CrawlerReviewRecord {
  return {
    review_priority: asString(raw.review_priority),
    school_key: asString(raw.school_key),
    school_name_zh: asString(raw.school_name_zh),
    school_name_en: asString(raw.school_name_en),
    website: asString(raw.website),
    final_admission_url: asString(raw.final_admission_url),
    application_form_links: splitLines(raw.application_form_links),
    application_open: asString(raw.application_open),
    application_period: asString(raw.application_period),
    submission_deadline: asString(raw.submission_deadline),
    exam_date: asString(raw.exam_date),
    interview_date: asString(raw.interview_date),
    second_interview_date: asString(raw.second_interview_date),
    result_notification_date: asString(raw.result_notification_date),
    required_materials: asString(raw.required_materials),
    confidence: confidence(raw.confidence),
    review_status: reviewStatus(raw.review_status),
    notes: asString(raw.notes),
    missing_fields: asString(raw.missing_fields),
    suggested_action: asString(raw.suggested_action),
    evidence_urls: splitLines(raw.evidence_urls),
    source_snapshot: asString(raw.source_snapshot),
  }
}

export async function getSchools(): Promise<AdmissionRecord[]> {
  const rows = await readJsonFile<Record<string, unknown>[]>('records.json', [])
  return rows.map(normalizeSchool).filter((row) => row.school_key)
}

export async function getReviewQueue(): Promise<CrawlerReviewRecord[]> {
  const rows = await readJsonFile<Record<string, unknown>[]>('review_queue.json', [])
  return rows.map(normalizeReview).filter((row) => row.school_key)
}

export async function getCrawlerSummary(): Promise<CrawlerSummary> {
  const [runSummary, publishManifest] = await Promise.all([
    readJsonFile<Record<string, any>>('run_summary.json', {}),
    readJsonFile<Record<string, any>>('publish_manifest.json', {}),
  ])
  return {
    generated_at: asString(runSummary.generated_at),
    published_at: asString(publishManifest.published_at),
    total_records: Number(runSummary.records?.total || 0),
    needs_review: Number(runSummary.review_queue?.total || 0),
    auto_selected: Number(runSummary.records?.review_status_counts?.auto_selected || 0),
    high_confidence: Number(runSummary.records?.confidence_counts?.high || 0),
    medium_confidence: Number(runSummary.records?.confidence_counts?.medium || 0),
    low_confidence: Number(runSummary.records?.confidence_counts?.low || 0),
    missing_confidence: Number(runSummary.records?.confidence_counts?.missing || 0),
    health: asString(publishManifest.health),
    notes: asString(publishManifest.notes),
  }
}

export async function hasSchoolKey(schoolKey: string): Promise<boolean> {
  const schools = await getSchools()
  return schools.some((school) => school.school_key === schoolKey)
}
