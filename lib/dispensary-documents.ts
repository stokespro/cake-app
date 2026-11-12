// Shared definitions for dispensary license documents (SPRO-279). Plain module
// (no 'use server') so client components, server actions and future checks
// share one definition.

export type DispensaryDocumentType = 'omma' | 'obn' | 'dea'

export const REQUIRED_DISPENSARY_DOCUMENT_TYPES: readonly DispensaryDocumentType[] = [
  'omma',
  'obn',
  'dea',
]

export const DISPENSARY_DOCUMENT_LABELS: Record<DispensaryDocumentType, string> = {
  omma: 'OMMA License',
  obn: 'OBN Registration',
  dea: 'DEA Registration',
}

export function isDispensaryDocumentType(value: unknown): value is DispensaryDocumentType {
  return (
    typeof value === 'string' &&
    (REQUIRED_DISPENSARY_DOCUMENT_TYPES as readonly string[]).includes(value)
  )
}

export const MAX_DISPENSARY_DOCUMENT_BYTES = 20 * 1024 * 1024

export const DISPENSARY_DOCUMENT_EXTENSIONS = ['pdf', 'jpg', 'jpeg', 'png', 'heic', 'heif'] as const

export const DISPENSARY_DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
] as const

export const DISPENSARY_DOCUMENT_ACCEPT = [
  ...DISPENSARY_DOCUMENT_EXTENSIONS.map(ext => `.${ext}`),
  ...DISPENSARY_DOCUMENT_MIME_TYPES,
].join(',')

const EXTENSION_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  heif: 'image/heif',
}

function extensionOf(fileName: string): string {
  const base = fileName.replace(/\\/g, '/').split('/').pop() ?? ''
  const idx = base.lastIndexOf('.')
  return idx === -1 ? '' : base.slice(idx + 1).toLowerCase()
}

/**
 * Resolves the MIME type to upload with. Prefers the browser-reported type when
 * allowed, otherwise maps from the extension (browsers often report '' for
 * HEIC). Returns null when the file is not an accepted type.
 */
export function mimeTypeForDocumentFile(fileName: string, browserType?: string): string | null {
  if (browserType && (DISPENSARY_DOCUMENT_MIME_TYPES as readonly string[]).includes(browserType)) {
    return browserType
  }
  return EXTENSION_MIME[extensionOf(fileName)] ?? null
}

/** Sanitizes an uploaded filename into a safe storage object basename. */
export function sanitizeDocumentFileName(fileName: string): string {
  const base = fileName.replace(/\\/g, '/').split('/').pop()?.trim() || 'document'

  let safe = base
    .toLowerCase()
    .replace(/\.\.+/g, '-')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')

  const ext = extensionOf(safe)
  const hasAllowedExt = (DISPENSARY_DOCUMENT_EXTENSIONS as readonly string[]).includes(ext)

  if (hasAllowedExt) {
    if (safe.length > 100) {
      const stem = safe.slice(0, safe.length - ext.length - 1).slice(0, 100 - ext.length - 1)
      safe = `${stem.replace(/[.-]+$/g, '')}.${ext}`
    }
  } else {
    safe = safe.slice(0, 100)
  }

  return safe.replace(/^[.-]+/, '') || 'document'
}

export interface DispensaryDocument {
  id: string
  dispensary_id: string
  document_type: DispensaryDocumentType
  file_path: string
  file_name: string
  mime_type: string | null
  file_size: number | null
  expiration_date: string | null
  uploaded_by: string | null
  uploaded_at: string
  uploaded_by_name?: string | null
  url?: string | null
}

/**
 * Which required documents is this dispensary missing?
 *
 * Returns the required types (OMMA, OBN, DEA, in that order) that have no row.
 * Expiration is deliberately ignored: an expired document still counts as on
 * file. The packing-hold follow-up should depend on this function.
 */
export function getMissingDocumentTypes(
  docs: ReadonlyArray<{ document_type: string }>
): DispensaryDocumentType[] {
  const present = new Set(docs.map(d => d.document_type))
  return REQUIRED_DISPENSARY_DOCUMENT_TYPES.filter(t => !present.has(t))
}
