'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Upload, Trash2, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { createClient } from '@/lib/supabase/client'
import { DISPENSARY_DOCUMENTS_BUCKET } from '@/lib/storage-buckets'
import {
  DISPENSARY_DOCUMENT_ACCEPT,
  DISPENSARY_DOCUMENT_LABELS,
  MAX_DISPENSARY_DOCUMENT_BYTES,
  REQUIRED_DISPENSARY_DOCUMENT_TYPES,
  mimeTypeForDocumentFile,
  type DispensaryDocument,
  type DispensaryDocumentType,
} from '@/lib/dispensary-documents'
import {
  attachDispensaryDocument,
  createDispensaryDocumentUploadUrl,
  getDispensaryDocuments,
  removeDispensaryDocument,
  updateDispensaryDocumentExpiration,
} from '@/actions/dispensary-documents'

interface Props {
  dispensaryId: string
  onChange?: () => void
}

// Renders inside the edit sheet's <form>: every button is type="button" and
// Enter in the date input is swallowed so it can't submit the profile form.
export function DispensaryDocumentsEditor({ dispensaryId, onChange }: Props) {
  const [documents, setDocuments] = useState<DispensaryDocument[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [busy, setBusy] = useState<Partial<Record<DispensaryDocumentType, boolean>>>({})
  const [pendingDates, setPendingDates] = useState<Partial<Record<DispensaryDocumentType, string>>>({})
  const [confirmRemove, setConfirmRemove] = useState<DispensaryDocumentType | null>(null)
  const fileInputs = useRef<Partial<Record<DispensaryDocumentType, HTMLInputElement | null>>>({})

  const load = useCallback(async () => {
    const result = await getDispensaryDocuments(dispensaryId)
    if (result.success && result.documents) {
      setDocuments(result.documents)
      setLoadError(false)
    } else {
      setLoadError(true)
    }
    setLoaded(true)
  }, [dispensaryId])

  useEffect(() => {
    load()
  }, [load])

  const setSlotBusy = (type: DispensaryDocumentType, value: boolean) =>
    setBusy(prev => ({ ...prev, [type]: value }))

  const docFor = (type: DispensaryDocumentType) => documents.find(d => d.document_type === type)

  const handleFile = async (type: DispensaryDocumentType, file: File) => {
    const mime = mimeTypeForDocumentFile(file.name, file.type)
    if (!mime) {
      toast.error('Only PDF, JPG, PNG and HEIC files are supported')
      return
    }
    if (file.size > MAX_DISPENSARY_DOCUMENT_BYTES) {
      toast.error('File must be under 20 MB')
      return
    }

    setSlotBusy(type, true)
    try {
      const existing = docFor(type)
      const expiration = pendingDates[type] ?? existing?.expiration_date ?? null

      const urlResult = await createDispensaryDocumentUploadUrl(dispensaryId, type, file.name)
      if (!urlResult.success || !urlResult.path || !urlResult.token) {
        toast.error(urlResult.error || 'Could not start upload')
        return
      }

      const supabase = createClient()
      const { error: uploadError } = await supabase.storage
        .from(DISPENSARY_DOCUMENTS_BUCKET)
        .uploadToSignedUrl(urlResult.path, urlResult.token, file, { contentType: mime })
      if (uploadError) {
        toast.error(`Upload failed: ${uploadError.message}`)
        return
      }

      const attach = await attachDispensaryDocument(
        dispensaryId,
        type,
        urlResult.path,
        file.name,
        expiration || null
      )
      if (!attach.success) {
        toast.error(attach.error || 'Could not save document')
        return
      }

      setPendingDates(prev => ({ ...prev, [type]: undefined }))
      toast.success(`${DISPENSARY_DOCUMENT_LABELS[type]} saved`)
      await load()
      onChange?.()
    } finally {
      setSlotBusy(type, false)
    }
  }

  const handleRemove = async (type: DispensaryDocumentType) => {
    setSlotBusy(type, true)
    const result = await removeDispensaryDocument(dispensaryId, type)
    setSlotBusy(type, false)
    if (!result.success) {
      toast.error(result.error || 'Could not remove document')
      return
    }
    toast.success(`${DISPENSARY_DOCUMENT_LABELS[type]} removed`)
    await load()
    onChange?.()
  }

  const handleDateChange = async (type: DispensaryDocumentType, value: string) => {
    const existing = docFor(type)
    if (!existing) {
      setPendingDates(prev => ({ ...prev, [type]: value }))
      return
    }
    // Optimistic local update, then persist.
    setDocuments(prev =>
      prev.map(d => (d.document_type === type ? { ...d, expiration_date: value || null } : d))
    )
    const result = await updateDispensaryDocumentExpiration(dispensaryId, type, value || null)
    if (!result.success) {
      toast.error(result.error || 'Could not update expiration date')
      await load()
      return
    }
    onChange?.()
  }

  if (!loaded) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading documents...
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {loadError && (
        <p className="text-sm text-red-600">Could not load documents. Try reopening this sheet.</p>
      )}
      {REQUIRED_DISPENSARY_DOCUMENT_TYPES.map(type => {
        const doc = docFor(type)
        const isBusy = !!busy[type]
        const dateValue = doc ? doc.expiration_date ?? '' : pendingDates[type] ?? ''
        return (
          <div key={type} className="rounded-lg border p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{DISPENSARY_DOCUMENT_LABELS[type]}</span>
              {doc ? (
                doc.url ? (
                  <a
                    href={doc.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-sm text-primary hover:underline truncate"
                  >
                    <span className="truncate max-w-[10rem]">{doc.file_name}</span>
                    <ExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                ) : (
                  <span className="text-sm truncate">{doc.file_name}</span>
                )
              ) : (
                <span className="text-sm text-red-600">Missing</span>
              )}
            </div>

            <div className="space-y-1">
              <Label htmlFor={`doc-exp-${type}`} className="text-xs text-muted-foreground">
                Expiration date (optional)
              </Label>
              <Input
                id={`doc-exp-${type}`}
                type="date"
                value={dateValue}
                disabled={isBusy}
                onChange={e => handleDateChange(type, e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') e.preventDefault()
                }}
              />
            </div>

            <div className="flex gap-2">
              <input
                ref={el => {
                  fileInputs.current[type] = el
                }}
                type="file"
                className="hidden"
                accept={DISPENSARY_DOCUMENT_ACCEPT}
                onChange={e => {
                  const file = e.target.files?.[0]
                  e.target.value = ''
                  if (file) handleFile(type, file)
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isBusy}
                onClick={() => fileInputs.current[type]?.click()}
              >
                {isBusy ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="mr-2 h-4 w-4" />
                )}
                {doc ? 'Replace' : 'Upload'}
              </Button>
              {doc && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isBusy}
                  onClick={() => setConfirmRemove(type)}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Remove
                </Button>
              )}
            </div>
          </div>
        )
      })}

      <AlertDialog open={confirmRemove !== null} onOpenChange={open => !open && setConfirmRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove document?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the uploaded {confirmRemove ? DISPENSARY_DOCUMENT_LABELS[confirmRemove] : ''} file.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
            <AlertDialogAction
              type="button"
              onClick={() => {
                const t = confirmRemove
                setConfirmRemove(null)
                if (t) handleRemove(t)
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
