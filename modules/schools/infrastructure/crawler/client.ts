import type { AdmissionRecord, CrawlerConfig, CrawlerReviewDecision, CrawlerReviewRecord, CrawlerSummary, CrawlerTicket } from '@/types/index'

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `Request failed: ${response.status}`)
  }
  return response.json() as Promise<T>
}

export const crawlerApi = {
  schools: () => requestJson<AdmissionRecord[]>('/api/crawler/schools'),
  summary: () => requestJson<CrawlerSummary>('/api/crawler/summary'),
  reviewQueue: () => requestJson<CrawlerReviewRecord[]>('/api/crawler/review-queue'),
  tickets: () => requestJson<CrawlerTicket[]>('/api/crawler/tickets'),
  createTicket: (input: Pick<CrawlerTicket, 'school_key' | 'school_name_zh' | 'field' | 'description' | 'reporter'>) =>
    requestJson<CrawlerTicket>('/api/crawler/tickets', { method: 'POST', body: JSON.stringify(input) }),
  updateTicket: (input: Pick<CrawlerTicket, 'id'> & Partial<Pick<CrawlerTicket, 'status' | 'admin_note'>>) =>
    requestJson<CrawlerTicket>('/api/crawler/tickets', { method: 'PATCH', body: JSON.stringify(input) }),
  config: () => requestJson<CrawlerConfig>('/api/crawler/config'),
  saveConfig: (input: Partial<CrawlerConfig>) => requestJson<CrawlerConfig>('/api/crawler/config', { method: 'PUT', body: JSON.stringify(input) }),
  reviewDecisions: () => requestJson<CrawlerReviewDecision[]>('/api/crawler/review-decisions'),
  saveReviewDecision: (input: Pick<CrawlerReviewDecision, 'school_key' | 'status' | 'suggestion' | 'reviewer'>) =>
    requestJson<CrawlerReviewDecision>('/api/crawler/review-decisions', { method: 'POST', body: JSON.stringify(input) }),
}
