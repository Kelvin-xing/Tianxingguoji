import { handleApiRequest, createApiError, type JsonValue } from '@/modules/shared/public'
import { requireActor, requireRole } from '@/modules/identity/web'
import { createCase, CaseCommandError, listCases, type CreateCaseInput } from '@/modules/cases/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  return handleApiRequest(request, async () => {
    const actor = requireRole(await requireActor(), ['founder', 'admin', 'advisor'])
    try {
      return { cases: await listCases(actor) } satisfies JsonValue
    } catch {
      throw createApiError('SERVICE_UNAVAILABLE')
    }
  })
}

export async function POST(request: Request): Promise<Response> {
  return handleApiRequest(request, async () => {
    const actor = requireRole(await requireActor(), ['founder', 'admin', 'advisor'])
    let body: unknown
    try {
      body = await request.json()
    } catch {
      throw createApiError('VALIDATION_FAILED')
    }

    try {
      const input = parseCreateCaseInput(body)
      return { case: await createCase(actor, input) } satisfies JsonValue
    } catch (error) {
      if (error instanceof CaseCommandError) {
        if (error.code === 'DUPLICATE_CASE') throw createApiError('CONFLICT')
        if (error.code === 'FORBIDDEN') throw createApiError('FORBIDDEN')
        if (error.code === 'STUDENT_NOT_FOUND') throw createApiError('NOT_FOUND')
        if (error.code === 'MANIFEST_NOT_APPROVED') throw createApiError('CONFLICT')
        throw createApiError('VALIDATION_FAILED')
      }
      throw createApiError('SERVICE_UNAVAILABLE')
    }
  })
}

function parseCreateCaseInput(value: unknown): CreateCaseInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CaseCommandError('VALIDATION_FAILED')
  }
  const body = value as Record<string, unknown>
  if (
    typeof body.student_id !== 'string' ||
    typeof body.intake_year !== 'number' ||
    typeof body.admission_type !== 'string' ||
    typeof body.manifest_id !== 'string'
  ) {
    throw new CaseCommandError('VALIDATION_FAILED')
  }
  if (body.primary_role_binding_id !== undefined && typeof body.primary_role_binding_id !== 'string') {
    throw new CaseCommandError('VALIDATION_FAILED')
  }
  return {
    studentId: body.student_id,
    intakeYear: body.intake_year,
    admissionType: body.admission_type,
    manifestId: body.manifest_id,
    primaryRoleBindingId: body.primary_role_binding_id as string | undefined,
  }
}
