'use client'

import { useRef, useState, type ChangeEvent } from 'react'
import Image from 'next/image'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Loader2, Upload, X } from 'lucide-react'
import { cn } from '@/lib/utils'

const DEFAULT_ACCEPT = 'image/png,image/jpeg,image/webp,image/svg+xml'
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024

interface ImageUploadProps {
  label: string
  value: string | null
  onUpload: (file: File) => Promise<void>
  onRemove: () => Promise<void>
  disabled?: boolean
  accept?: string
  maxBytes?: number
  helperText?: string
  className?: string
}

// Reusable image upload control: shows a thumbnail when a value is set, a
// file picker when not, plus Replace/Remove buttons and an uploading state.
// Client-side validates type + size before calling onUpload so users get
// instant feedback; the caller (onUpload) is responsible for the actual
// signed-URL upload + attach round trip.
export function ImageUpload({
  label,
  value,
  onUpload,
  onRemove,
  disabled = false,
  accept = DEFAULT_ACCEPT,
  maxBytes = DEFAULT_MAX_BYTES,
  helperText,
  className,
}: ImageUploadProps) {
  const [uploading, setUploading] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const acceptedTypes = accept.split(',').map(t => t.trim())
  const busy = uploading || removing || disabled

  async function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    if (!acceptedTypes.includes(file.type)) {
      setError('Unsupported file type — use PNG, JPEG, WebP, or SVG')
      return
    }

    if (file.size > maxBytes) {
      setError(`File must be ${Math.round(maxBytes / (1024 * 1024))} MB or smaller`)
      return
    }

    setError('')
    setUploading(true)
    try {
      await onUpload(file)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  async function handleRemove() {
    setError('')
    setRemoving(true)
    try {
      await onRemove()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove image')
    } finally {
      setRemoving(false)
    }
  }

  return (
    <div className={cn('space-y-2', className)}>
      <Label>{label}</Label>

      {value ? (
        <div className="flex items-center gap-3 rounded-md border p-2">
          <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-md bg-muted">
            <Image src={value} alt={label} fill sizes="64px" className="object-cover" unoptimized />
          </div>
          <div className="flex flex-1 flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => inputRef.current?.click()}
              disabled={busy}
            >
              {uploading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-1 h-3.5 w-3.5" />}
              Replace
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleRemove}
              disabled={busy}
            >
              {removing ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <X className="mr-1 h-3.5 w-3.5" />}
              Remove
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="w-full sm:w-auto"
        >
          {uploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
          {uploading ? 'Uploading…' : 'Upload image'}
        </Button>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={accept}
        onChange={handleFileChange}
        className="hidden"
        disabled={busy}
      />

      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : helperText ? (
        <p className="text-xs text-muted-foreground">{helperText}</p>
      ) : null}
    </div>
  )
}
