'use client'

import { Minus, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface PlantStepperProps {
  id: string
  label: string
  /** null = nothing entered yet. There is deliberately no default. */
  value: number | null
  onChange: (next: number | null) => void
  min?: number
  max?: number
  note?: string
  warning?: string | null
}

/** Whole-number stepper with big +/- buttons and a typeable centre. */
export function PlantStepper({ id, label, value, onChange, min = 1, max = 500, note, warning }: PlantStepperProps) {
  function clamp(n: number): number {
    return Math.min(max, Math.max(min, n))
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
      </Label>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          aria-label="One fewer"
          className="h-12 w-12 shrink-0"
          disabled={value === null || value <= min}
          onClick={() => onChange(value === null ? null : clamp(value - 1))}
        >
          <Minus />
        </Button>
        <Input
          id={id}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          enterKeyHint="done"
          placeholder="--"
          value={value === null ? '' : String(value)}
          onChange={(e) => {
            const t = e.target.value
            if (t === '') return onChange(null)
            if (!/^\d{1,3}$/.test(t)) return
            onChange(clamp(Number(t)))
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              e.currentTarget.blur()
            }
          }}
          className="h-12 text-center text-lg font-semibold md:text-xl"
        />
        <Button
          type="button"
          variant="outline"
          aria-label="One more"
          className="h-12 w-12 shrink-0"
          disabled={value !== null && value >= max}
          onClick={() => onChange(value === null ? min : clamp(value + 1))}
        >
          <Plus />
        </Button>
      </div>
      {note && <p className="text-sm text-muted-foreground">{note}</p>}
      {warning && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-700 dark:text-amber-300">
          {warning}
        </p>
      )}
    </div>
  )
}
