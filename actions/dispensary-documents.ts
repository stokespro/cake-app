'use server'

import { requireRole } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { DISPENSARY_DOCUMENTS_BUCKET } from '@/lib/storage-buckets'
import {
  DISPENSARY_DOCUMENT_EXTENSIONS,
  DISPENSARY_DOCUMENT_MIME_TYPES,
  MAX_DISPENSARY_DOCUMENT_BYTES,
  getMissingDocumentTypes,
  isDispensaryDocumentType,
  sanitizeDocumentFileName,
  type DispensaryDocument,
  type DispensaryDocumentType,
} from '@/lib/dispensary-documents'

// Mirrors DISPENSARY_ROLES / EDIT_PROFILE_ROLES in actions/customers.ts.
const DOCUMENT_READ_ROLES = ['sales', 'agent', 'management', 'admin'] as const
const DOCUMENT_WRITE_ROLES = ['sales', 'agent', 'management', 'admin'] as const

const SIGNED_URL_TTL_SECONDS = 3600

function isValidExpiration(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

export async function getDispensaryDocuments(
  dispensaryId: string
): Promise<{ success: boolean; documents?: DispensaryDocument[]; error?: string }> {
  const auth = await requireRole([...DOCUMENT_READ_ROLES])
  if (!auth.authorized) return { success: false, error: auth.reason }

  const db = await createServiceClient()

  const { data, error } = await db
    .from('dispensary_documents')
    .select('*')
    .eq('dispensary_id', dispensaryId)

  if (error) {
    console.error('[dispensary-documents] fetch failed', error)
    return { success: false, error: 'Failed to load documents' }
  }

  const rows = (data ?? []) as DispensaryDocument[]

  // Resolve uploader names with a separate lookup.
  const userIds = Array.from(new Set(rows.map(r => r.uploaded_by).filter(Boolean))) as string[]
  const names = new Map<string, string>()
  if (userIds.length > 0) {
    const { data: users } = await db.from('users').select('id, name').in('id', userIds)
    for (const u of (users ?? []) as { id: string; name: string }[]) names.set(u.id, u.name)
  }

  const documents: DispensaryDocument[] = []
  for (const row of rows) {
    const { data: signed } = await db.storage
      .from(DISPENSARY_DOCUMENTS_BUCKET)
      .createSignedUrl(row.file_path, SIGNED_URL_TTL_SECONDS)
    documents.push({
      ...row,
      uploaded_by_name: row.uploaded_by ? names.get(row.uploaded_by) ?? null : null,
      url: signed?.signedUrl ?? null,
    })
  }

  return { success: true, documents }
}

export async function getDispensaryMissingDocuments(
  dispensaryId: string
): Promise<{ success: boolean; missing?: DispensaryDocumentType[]; error?: string }> {
  const auth = await requireRole([...DOCUMENT_READ_ROLES])
  if (!auth.authorized) return { success: false, error: auth.reason }

  const db = await createServiceClient()
  const { data, error } = await db
    .from('dispensary_documents')
    .select('document_type')
    .eq('dispensary_id', dispensaryId)

  if (error) {
    console.error('[dispensary-documents] missing lookup failed', error)
    return { success: false, error: 'Failed to load documents' }
  }

  return { success: true, missing: getMissingDocumentTypes(data ?? []) }
}

// Mints a signed upload URL; the browser uploads bytes straight to storage.
export async function createDispensaryDocumentUploadUrl(
  dispensaryId: string,
  documentType: DispensaryDocumentType,
  fileName: string
): Promise<{ success: boolean; path?: string; token?: string; error?: string }> {
  const auth = await requireRole([...DOCUMENT_WRITE_ROLES])
  if (!auth.authorized) return { success: false, error: auth.reason }

  if (!isDispensaryDocumentType(documentType)) {
    return { success: false, error: 'Invalid document type' }
  }

  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  if (!(DISPENSARY_DOCUMENT_EXTENSIONS as readonly string[]).includes(ext)) {
    return { success: false, error: 'Only PDF, JPG, PNG and HEIC files are supported' }
  }

  const db = await createServiceClient()

  const { data: customer, error: customerError } = await db
    .from('customers')
    .select('id')
    .eq('id', dispensaryId)
    .single()

  if (customerError || !customer) {
    return { success: false, error: 'Dispensary not found' }
  }

  const path = `${dispensaryId}/${documentType}/${Date.now()}-${sanitizeDocumentFileName(fileName)}`

  const { data, error } = await db.storage
    .from(DISPENSARY_DOCUMENTS_BUCKET)
    .createSignedUploadUrl(path)

  if (error || !data) {
    console.error('[dispensary-documents] signed upload url failed', error)
    return { success: false, error: 'Failed to create upload URL' }
  }

  return { success: true, path, token: data.token }
}

// Records a just-uploaded document (upsert: one active row per type).
export async function attachDispensaryDocument(
  dispensaryId: string,
  documentType: DispensaryDocumentType,
  path: string,
  fileName: string,
  expirationDate?: string | null
): Promise<{ success: boolean; document?: DispensaryDocument; error?: string }> {
  const auth = await requireRole([...DOCUMENT_WRITE_ROLES])
  if (!auth.authorized) return { success: false, error: auth.reason }

  if (!isDispensaryDocumentType(documentType)) {
    return { success: false, error: 'Invalid document type' }
  }

  // SECURITY: `path` is caller-supplied; without this a caller could attach an
  // arbitrary bucket object to a dispensary.
  const prefix = `${dispensaryId}/${documentType}/`
  if (!path.startsWith(prefix) || path.includes('..')) {
    return { success: false, error: 'Invalid file path' }
  }

  const expiration = expirationDate ?? null
  if (!isValidExpiration(expiration)) {
    return { success: false, error: 'Invalid expiration date' }
  }

  const db = await createServiceClient()
  const bucket = db.storage.from(DISPENSARY_DOCUMENTS_BUCKET)

  const basename = path.slice(prefix.length)

  const { data: listing, error: listError } = await bucket.list(
    `${dispensaryId}/${documentType}`,
    { search: basename }
  )

  if (listError) {
    console.error('[dispensary-documents] list failed', listError)
    return { success: false, error: 'Failed to verify upload' }
  }

  const uploaded = listing?.find(item => item.name === basename)
  if (!uploaded) {
    return { success: false, error: 'Upload not found' }
  }

  const size = uploaded.metadata?.size as number | undefined
  const mimetype = uploaded.metadata?.mimetype as string | undefined

  if (
    (size !== undefined && size > MAX_DISPENSARY_DOCUMENT_BYTES) ||
    (mimetype && !(DISPENSARY_DOCUMENT_MIME_TYPES as readonly string[]).includes(mimetype))
  ) {
    await bucket.remove([path])
    return { success: false, error: 'File must be a PDF, JPG, PNG or HEIC under 20 MB' }
  }

  const { data: existing } = await db
    .from('dispensary_documents')
    .select('file_path')
    .eq('dispensary_id', dispensaryId)
    .eq('document_type', documentType)
    .maybeSingle()

  const oldPath = (existing as { file_path?: string } | null)?.file_path ?? null

  const { data, error } = await db
    .from('dispensary_documents')
    .upsert(
      {
        dispensary_id: dispensaryId,
        document_type: documentType,
        file_path: path,
        file_name: fileName.trim().slice(0, 255),
        mime_type: mimetype ?? null,
        file_size: size ?? null,
        expiration_date: expiration,
        uploaded_by: auth.session.userId,
        uploaded_at: new Date().toISOString(),
      },
      { onConflict: 'dispensary_id,document_type' }
    )
    .select('*')
    .single()

  if (error) {
    console.error('[dispensary-documents] attach failed', error)
    return { success: false, error: 'Failed to save document' }
  }

  if (oldPath && oldPath !== path) {
    // Best-effort cleanup of the replaced object.
    await bucket.remove([oldPath])
  }

  return { success: true, document: data as DispensaryDocument }
}

export async function removeDispensaryDocument(
  dispensaryId: string,
  documentType: DispensaryDocumentType
): Promise<{ success: boolean; error?: string }> {
  const auth = await requireRole([...DOCUMENT_WRITE_ROLES])
  if (!auth.authorized) return { success: false, error: auth.reason }

  if (!isDispensaryDocumentType(documentType)) {
    return { success: false, error: 'Invalid document type' }
  }

  const db = await createServiceClient()

  const { data: existing, error: fetchError } = await db
    .from('dispensary_documents')
    .select('id, file_path')
    .eq('dispensary_id', dispensaryId)
    .eq('document_type', documentType)
    .maybeSingle()

  if (fetchError || !existing) {
    return { success: false, error: 'Document not found' }
  }

  const { error } = await db
    .from('dispensary_documents')
    .delete()
    .eq('dispensary_id', dispensaryId)
    .eq('document_type', documentType)

  if (error) {
    console.error('[dispensary-documents] remove failed', error)
    return { success: false, error: 'Failed to remove document' }
  }

  // Best-effort storage cleanup.
  await db.storage
    .from(DISPENSARY_DOCUMENTS_BUCKET)
    .remove([(existing as { file_path: string }).file_path])

  return { success: true }
}

export async function updateDispensaryDocumentExpiration(
  dispensaryId: string,
  documentType: DispensaryDocumentType,
  expirationDate: string | null
): Promise<{ success: boolean; error?: string }> {
  const auth = await requireRole([...DOCUMENT_WRITE_ROLES])
  if (!auth.authorized) return { success: false, error: auth.reason }

  if (!isDispensaryDocumentType(documentType)) {
    return { success: false, error: 'Invalid document type' }
  }
  if (!isValidExpiration(expirationDate)) {
    return { success: false, error: 'Invalid expiration date' }
  }

  const db = await createServiceClient()

  const { data, error } = await db
    .from('dispensary_documents')
    .update({ expiration_date: expirationDate })
    .eq('dispensary_id', dispensaryId)
    .eq('document_type', documentType)
    .select('id')

  if (error) {
    console.error('[dispensary-documents] expiration update failed', error)
    return { success: false, error: 'Failed to update expiration date' }
  }
  if (!data || data.length === 0) {
    return { success: false, error: 'Document not found' }
  }

  return { success: true }
}
