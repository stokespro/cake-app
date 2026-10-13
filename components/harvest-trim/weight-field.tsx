'use client'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatWeight, type WeightParseResult } from '@/lib/trim/weights'
import { gramsToLb } from '@/lib/units'
import type { WeightUnit } from '@/types/harvest-trim'

interface WeightFieldProps {
  id: string
  label: string
  unit: WeightUnit
  value: string
  onChange: (next: string) => void
  /** Result of parsing `value`; null while empty. Drives the converted line and the error. */
  parsed: WeightParseResult | null
  /** Extra note shown under the field (not an error). */
  note?: string
  /** Soft warning: annotates, never blocks. */
  warning?: string | null
  /** Show a one-tap "None" (0) button, for buckets that are legitimately empty. */
  onZero?: () => void
  autoFocus?: boolean
  disabled?: boolean
}

/**
 * The module's weight input: the vault's idiom (text + inputMode decimal +
 * keystroke filter, vault/page.tsx) made bigger for gloved hands, with the other
 * unit's figure shown underneath so a reading can be checked against either scale.
 * The keystroke filter itself lives in useWeightFields -> lib/trim/weights.ts.
 */
export function WeightField({
  id,
  label,
  unit,
  value,
  onChange,
  parsed,
  note,
  warning,
  onZero,
  autoFocus,
  disabled,
}: WeightFieldProps) {
  const error = parsed && !parsed.ok ? parsed.message : null
  const other: WeightUnit = unit === 'lb' ? 'g' : 'lb'
  const converted =
    parsed && parsed.ok
      ? other === 'g'
        ? `${formatWeight(parsed.grams, 'g')} g`
        : `${gramsToLb(parsed.grams).toFixed(3)} lb`
      : null

  return (
    <div className="space-y-1.5">
      <div className="flex items-end justify-between gap-2">
        <Label htmlFor={id}>
          {label}
        </Label>
        {onZero && (
          <Button
            type="button"
            variant="outline"
            className="h-10 px-4 text-sm"
            onClick={onZero}
            disabled={disabled}
          >
            None (0)
          </Button>
        )}
      </div>
      <div className="relative">
        <Input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          enterKeyHint="done"
          placeholder="0.00"
          value={value}
          autoFocus={autoFocus}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            // Done / Enter leaves the field so the next barcode scan is not typed into it.
            if (e.key === 'Enter') {
              e.preventDefault()
              e.currentTarget.blur()
            }
          }}
          className={cn(
            'h-12 pr-14 text-center text-lg font-semibold md:text-xl',
            error && 'border-destructive focus-visible:ring-destructive'
          )}
        />
        <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-lg text-muted-foreground">
          {unit}
        </span>
      </div>
      {error ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      ) : converted ? (
        <p className="text-center text-sm text-muted-foreground">= {converted}</p>
      ) : note ? (
        <p className="text-sm text-muted-foreground">{note}</p>
      ) : null}
      {warning && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-700 dark:text-amber-300">
          {warning}
        </p>
      )}
    </div>
  )
}

interface UnitToggleProps {
  unit: WeightUnit
  onChange: (unit: WeightUnit) => void
}

export function UnitToggle({ unit, onChange }: UnitToggleProps) {
  return (
    <div role="group" aria-label="Weight unit" className="inline-grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
      {(['lb', 'g'] as const).map((u) => (
        <button
          key={u}
          type="button"
          aria-pressed={unit === u}
          onClick={() => onChange(u)}
          className={cn(
            'h-12 min-w-16 rounded-md px-4 text-base font-semibold transition-colors',
            unit === u ? 'bg-background shadow-sm' : 'text-muted-foreground'
          )}
        >
          {u}
        </button>
      ))}
    </div>
  )
}
