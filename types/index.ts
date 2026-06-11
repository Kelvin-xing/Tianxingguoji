export type AdmissionType = 's1_admission' | 'transfer' | 'unknown'
export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'missing'
export type ReviewStatus = 'approved' | 'needs_review' | 'rejected' | 'auto_selected' | 'unknown'

export interface AdmissionRecord {
  school_key: string
  school_name_zh: string
  school_name_en: string
  website: string
  official_website?: string
  final_admission_url: string
  admission_type: AdmissionType
  confidence: ConfidenceLevel
  application_dates: string
  application_open?: string
  application_period?: string
  submission_deadline?: string
  exam_date?: string
  interview_date?: string
  result_notification_date?: string
  required_materials: string
  application_form_links: string[]
  evidence_urls: string[]
  review_status: ReviewStatus
  notes: string
  district?: string
  school_level?: string
  school_type?: string
  finance_type?: string
  address?: string
  phone?: string
  tuition_info?: string
  dormitory_info?: string
  is_sen?: boolean
}

export interface CrawlerReviewRecord {
  review_priority: 'high' | 'medium' | 'low' | string
  school_key: string
  school_name_zh: string
  school_name_en: string
  website: string
  final_admission_url: string
  application_form_links: string[]
  application_open: string
  application_period: string
  submission_deadline: string
  exam_date: string
  interview_date: string
  second_interview_date: string
  result_notification_date: string
  required_materials: string
  confidence: ConfidenceLevel
  review_status: ReviewStatus
  notes: string
  missing_fields: string
  suggested_action: string
  evidence_urls: string[]
  source_snapshot: string
}

export interface CrawlerTicket {
  id: string
  school_key: string
  school_name_zh: string
  field: string
  description: string
  reporter: string
  status: 'open' | 'reviewing' | 'resolved' | 'rejected'
  admin_note?: string
  created_at: string
  updated_at: string
}

export interface CrawlerReviewDecision {
  school_key: string
  status: 'approved' | 'needs_changes'
  suggestion: string
  reviewer: string
  created_at: string
  updated_at: string
}

export interface CrawlerConfig {
  enabled: boolean
  frequency: 'manual' | 'daily' | 'weekly' | 'monthly'
  school_levels: string[]
  max_parallel: number
  llm_enabled: boolean
  updated_at: string
}

export interface CrawlerSummary {
  generated_at: string
  published_at?: string
  total_records: number
  needs_review: number
  auto_selected: number
  high_confidence: number
  medium_confidence: number
  low_confidence: number
  missing_confidence: number
  health?: string
  notes?: string
}


export interface StudyApplicationAssessment {
  applicant_name: string
  age: string
  highest_education_institution: string
  prior_education: string
  major: string
  gpa: string
  english_level: string
  english_test_score: string
  work_experience: string
  industry: string
  awards_or_experiences: string
  study_abroad_purpose: string
  target_institutions: string
  preferred_major: string
  other_requirements: string
  planned_enrollment_time: string
}

export interface Student {
  id: string
  name_zh: string
  name_en: string
  current_grade: string
  target_grade: string
  target_schools: string[]
  application_assessment: StudyApplicationAssessment
  status: 'collecting' | 'applying' | 'interview' | 'admitted' | 'rejected'
  consultant: string
  deadline: string
  documents: { name: string; uploaded: boolean }[]
  notes: string
  created_at: string
  updated_at: string
}

export interface StatsSnapshot {
  active_students: number
  pending_deadlines: number
  school_db_count: number
  ai_queries_month: number
}
