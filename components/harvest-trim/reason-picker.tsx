'use client'

import { cn } from '@/lib/utils'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

/** Same floor the server enforces (cleanReason): at least 3 characters. */
export const MIN_REASON_CHARS = 3

export function reasonIsValid(reason: string): boolean {
  return reason.trim().length >= MIN_REASON_CHARS
}

interface ReasonPickerProps {
  id: string
  chips: readonly string[]
  value: string
  onChange: (next: string) => void
  label?: string
  /** Visual treatment for the red discrepancy screen. */
  tone?: 'default' | 'onRed'
}

/** Reason chips plus free text. Tapping a chip fills the box; the text stays editable. */
export function ReasonPicker({ id, chips, value, onChange, label = 'Reason', tone = 'default' }: ReasonPickerProps) {
  const onRed = tone === 'onRed'
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className={cn('text-base font-semibold', onRed && 'text-white')}>
        {label} <span className={cn('text-sm font-normal', onRed ? 'text-white/80' : 'text-muted-foreground')}>(required)</span>
      </Label>
      <div className="flex flex-wrap gap-2">
        {chips.map((chip) => {
          const selected = value.trim().toLowerCase() === chip.toLowerCase()
          return (
            <button
              key={chip}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(chip === 'Other' ? '' : chip)}
              className={cn(
                'h-14 rounded-lg border-2 px-4 text-base font-medium transition-colors',
                onRed
                  ? selected
                    ? 'border-white bg-white text-red-700'
                    : 'border-white/60 bg-transparent text-white'
                  : selected
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-background hover:bg-muted'
              )}
            >
              {chip}
            </button>
          )
        })}
      </div>
      <Textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        maxLength={500}
        placeholder="Tell us what happened (at least 3 characters)"
        className={cn('text-base', onRed && 'border-white/60 bg-white text-zinc-900')}
      />
    </div>
  )
}
