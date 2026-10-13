'use server'

import { requireRole } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
// Roles that can access compliance (mirrors canViewSection('compliance'))
const COMPLIANCE_ROLES = ['admin', 'management', 'vault', 'packaging', 'trim_manager'] as const

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ComplianceEntry {
  id: string
  event_date: string
  report_type: string
  custom_report_type: string | null
  summary: string
  metrc_ids: string[]
  location: string | null
  witness: string | null
  logged_by: string
  last_edited_by: string | null
  last_edited_at: string | null
  is_edited: boolean | null
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
  logged_by_user: { id: string; name: string } | null
  editor: { id: string; name: string } | null
}

export interface CreateComplianceEntryInput {
  event_date: string
  report_type: string
  custom_report_type: string | null
  summary: string
  metrc_ids: string[]
  location: string | null
  witness: string | null
  metadata: Record<string, unknown>
}

export type UpdateComplianceEntryInput = CreateComplianceEntryInput

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Fetch all compliance log entries, ordered by event_date descending.
 */
export async function getComplianceEntries(): Promise<
  { data: ComplianceEntry[]; error?: never } | { data?: never; error: string }
> {
  const auth = await requireRole([...COMPLIANCE_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const { data, error } = await db
    .from('compliance_log')
    .select('*, logged_by_user:users!compliance_log_logged_by_fkey(id, name), editor:users!compliance_log_last_edited_by_fkey(id, name)')
    .order('event_date', { ascending: false })
    .limit(1000)

  if (error) {
    console.error('[compliance] getComplianceEntries error:', error)
    return { error: 'Failed to load compliance log' }
  }

  return { data: (data as ComplianceEntry[]) ?? [] }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Log a new compliance event.
 */
export async function createComplianceEntry(input: CreateComplianceEntryInput): Promise<
  { error?: never } | { error: string }
> {
  const auth = await requireRole([...COMPLIANCE_ROLES])
  if (!auth.authorized) return { error: auth.reason }

  if (!input.summary?.trim()) return { error: 'Summary is required' }
  if (!input.event_date) return { error: 'Event date is required' }

  const db = await createServiceClient()

  const { error } = await db.from('compliance_log').insert({
    event_date: new Date(input.event_date).toISOString(),
    report_type: input.report_type,
    custom_report_type: input.report_type === 'other' ? input.custom_report_type || null : null,
    summary: input.summary.trim(),
    metrc_ids: input.metrc_ids,
    location: input.location?.trim() || null,
    witness: input.witness?.trim() || null,
    metadata: input.metadata,
    logged_by: auth.session.userId,
  })

  if (error) {
    console.error('[compliance] createComplianceEntry error:', error)
    return { error: 'Failed to save compliance entry' }
  }

  return {}
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/**
 * Update an existing compliance log entry.
 * Only admin/management can edit.
 */
export async function updateComplianceEntry(
  entryId: string,
  input: UpdateComplianceEntryInput
): Promise<{ error?: never } | { error: string }> {
  const auth = await requireRole(['admin', 'management'])
  if (!auth.authorized) return { error: auth.reason }

  if (!input.summary?.trim()) return { error: 'Summary is required' }
  if (!input.event_date) return { error: 'Event date is required' }

  const db = await createServiceClient()

  const { error } = await db
    .from('compliance_log')
    .update({
      event_date: new Date(input.event_date).toISOString(),
      report_type: input.report_type,
      custom_report_type: input.report_type === 'other' ? input.custom_report_type || null : null,
      summary: input.summary.trim(),
      metrc_ids: input.metrc_ids,
      location: input.location?.trim() || null,
      witness: input.witness?.trim() || null,
      metadata: input.metadata,
      last_edited_by: auth.session.userId,
      last_edited_at: new Date().toISOString(),
      is_edited: true,
      updated_at: new Date().toISOString(),
    })
    .eq('id', entryId)

  if (error) {
    console.error('[compliance] updateComplianceEntry error:', error)
    return { error: 'Failed to update compliance entry' }
  }

  return {}
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Delete a compliance log entry.
 * Only admin/management can delete.
 */
export async function deleteComplianceEntry(entryId: string): Promise<
  { error?: never } | { error: string }
> {
  const auth = await requireRole(['admin', 'management'])
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const { error } = await db.from('compliance_log').delete().eq('id', entryId)

  if (error) {
    console.error('[compliance] deleteComplianceEntry error:', error)
    return { error: 'Failed to delete compliance entry' }
  }

  return {}
}
