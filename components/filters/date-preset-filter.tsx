'use client'

import { ArrowRight } from 'lucide-react'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import {
  datePresetOptions,
  todayDateString,
  type DatePresetKey,
} from '@/lib/date-filters'

export interface DatePresetFilterProps {
  /** Currently selected preset. */
  value: DatePresetKey
  onValueChange: (preset: DatePresetKey) => void
  /** Which presets to offer, in display order (e.g. ORDER_DATE_PRESETS). */
  presets: DatePresetKey[]
  /** Custom range, as `yyyy-MM-dd` strings. Only used when value === 'custom'. */
  customFrom: string
  customTo: string
  onCustomFromChange: (value: string) => void
  onCustomToChange: (value: string) => void
  placeholder?: string
  /** Prefix for the custom input ids, so several filters can coexist on a page. */
  idPrefix?: string
  className?: string
  customRangeClassName?: string
}

/**
 * Preset date-range filter: a preset dropdown plus, when "Custom" is picked, a
 * from/to pair of date inputs. Shared by list pages (orders, cultivation tasks)
 * — preset definitions and range resolution live in `lib/date-filters.ts`.
 *
 * Renders as a fragment so the caller's own flex/grid layout positions the
 * dropdown and the custom-range block as siblings.
 */
export function DatePresetFilter({
  value,
  onValueChange,
  presets,
  customFrom,
  customTo,
  onCustomFromChange,
  onCustomToChange,
  placeholder = 'Date range',
  idPrefix = 'date-filter',
  className,
  customRangeClassName,
}: DatePresetFilterProps) {
  /** Entering Custom seeds both dates to today (rather than leaving them
   * unbounded); leaving Custom clears them so a stale range can't linger. */
  function handleChange(next: DatePresetKey) {
    onValueChange(next)
    if (next === 'custom') {
      const today = todayDateString()
      if (!customFrom) onCustomFromChange(today)
      if (!customTo) onCustomToChange(today)
    } else {
      onCustomFromChange('')
      onCustomToChange('')
    }
  }

  return (
    <>
      <Select value={value} onValueChange={(v) => handleChange(v as DatePresetKey)}>
        <SelectTrigger className={className}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {datePresetOptions(presets).map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {value === 'custom' && (
        <div className={cn('flex items-center gap-2 w-full sm:w-auto', customRangeClassName)}>
          <Input
            id={`${idPrefix}-from`}
            type="date"
            value={customFrom}
            onChange={(e) => onCustomFromChange(e.target.value)}
            aria-label="Start date"
            className="flex-1 min-w-0"
          />
          <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
          <Input
            id={`${idPrefix}-to`}
            type="date"
            value={customTo}
            onChange={(e) => onCustomToChange(e.target.value)}
            aria-label="End date"
            className="flex-1 min-w-0"
          />
        </div>
      )}
    </>
  )
}
