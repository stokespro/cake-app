import { describe, expect, it } from 'vitest'
import {
  getMissingDocumentTypes,
  isDispensaryDocumentType,
  mimeTypeForDocumentFile,
  sanitizeDocumentFileName,
} from './dispensary-documents'

describe('getMissingDocumentTypes', () => {
  it('returns all required types for no documents', () => {
    expect(getMissingDocumentTypes([])).toEqual(['omma', 'obn', 'dea'])
  })
  it('returns [] when all are present', () => {
    expect(
      getMissingDocumentTypes([
        { document_type: 'dea' },
        { document_type: 'omma' },
        { document_type: 'obn' },
      ])
    ).toEqual([])
  })
  it('returns the remainder in canonical order', () => {
    expect(getMissingDocumentTypes([{ document_type: 'obn' }])).toEqual(['omma', 'dea'])
  })
  it('handles duplicate rows', () => {
    expect(
      getMissingDocumentTypes([{ document_type: 'omma' }, { document_type: 'omma' }])
    ).toEqual(['obn', 'dea'])
  })
  it('ignores unknown and uppercase types', () => {
    expect(
      getMissingDocumentTypes([{ document_type: 'OMMA' }, { document_type: 'other' }])
    ).toEqual(['omma', 'obn', 'dea'])
  })
  it('does not consider expiration', () => {
    const docs = [{ document_type: 'omma', expiration_date: '2000-01-01' }]
    expect(getMissingDocumentTypes(docs)).toEqual(['obn', 'dea'])
  })
})

describe('isDispensaryDocumentType', () => {
  it('accepts only the three types', () => {
    expect(isDispensaryDocumentType('omma')).toBe(true)
    expect(isDispensaryDocumentType('dea')).toBe(true)
    expect(isDispensaryDocumentType('OMMA')).toBe(false)
    expect(isDispensaryDocumentType(undefined)).toBe(false)
  })
})

describe('mimeTypeForDocumentFile', () => {
  it('maps empty browser type for .heic', () => {
    expect(mimeTypeForDocumentFile('IMG_1.HEIC', '')).toBe('image/heic')
  })
  it('prefers an allowed browser type', () => {
    expect(mimeTypeForDocumentFile('a.jpg', 'image/jpeg')).toBe('image/jpeg')
  })
  it('returns null for disallowed files', () => {
    expect(mimeTypeForDocumentFile('a.docx', 'application/msword')).toBeNull()
    expect(mimeTypeForDocumentFile('noext')).toBeNull()
  })
})

describe('sanitizeDocumentFileName', () => {
  it('strips path traversal', () => {
    const out = sanitizeDocumentFileName('../../etc/passwd.pdf')
    expect(out).toBe('passwd.pdf')
    expect(out).not.toContain('/')
  })
  it('replaces disallowed characters and lowercases', () => {
    expect(sanitizeDocumentFileName('My License (1).PDF')).toBe('my-license-1-.pdf')
  })
  it('keeps allowed extensions', () => {
    expect(sanitizeDocumentFileName('a.heic')).toBe('a.heic')
    expect(sanitizeDocumentFileName('a.png')).toBe('a.png')
  })
  it('falls back to document for empty input', () => {
    expect(sanitizeDocumentFileName('')).toBe('document')
  })
  it('caps length and keeps the extension', () => {
    const out = sanitizeDocumentFileName(`${'a'.repeat(300)}.pdf`)
    expect(out.length).toBeLessThanOrEqual(100)
    expect(out.endsWith('.pdf')).toBe(true)
  })
})
