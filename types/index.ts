export interface AdmissionRecord {
  school_key: string
  school_name_zh: string
  school_name_en: string
  website: string
  final_admission_url: string
  admission_type: 's1_admission' | 'transfer' | 'unknown'
  confidence: 'high' | 'medium' | 'low'
  application_dates: string
  required_materials: string
  application_form_links: string[]
  evidence_urls: string[]
  review_status: 'approved' | 'needs_review' | 'rejected'
  notes: string
  district?: string
}

export interface Student {
  id: string
  name_zh: string
  name_en: string
  current_grade: string
  target_grade: string
  target_schools: string[]
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
