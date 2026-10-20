'use client'

// State for a group of weight inputs that share one unit (lb or g).
//
// Fields hold TEXT, because that is what a person is typing; stored grams come
// from lib/trim/weights.ts parseWeightInput(), the only parser. The unit is
// remembered per device (a scale is either in lb or g) and switching it converts
// every field already filled in, so nothing has to be re-typed.

import { useCallback, useState } from 'react'
import {
  WEIGHT_DECIMALS,
  formatWeight,
  isKeystrokeAllowed,
  parseWeightInput,
  type ParseWeightOptions,
  type WeightParseResult,
} from '@/lib/trim/weights'
import type { WeightUnit } from '@/types/harvest-trim'

const UNIT_KEY = 'harvest-trim-weight-unit'

function readUnit(): WeightUnit {
  try {
    const v = typeof window === 'undefined' ? null : window.localStorage.getItem(UNIT_KEY)
    return v === 'g' ? 'g' : 'lb'
  } catch {
    return 'lb'
  }
}

function writeUnit(unit: WeightUnit): void {
  try {
    window.localStorage.setItem(UNIT_KEY, unit)
  } catch {
    // Private mode / storage disabled: the preference just doesn't stick.
  }
}

/** "2.410" -> "2.41", "3.000" -> "3" */
function tidy(text: string): string {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text
}

export function gramsToText(grams: number, unit: WeightUnit): string {
  return tidy(formatWeight(grams, unit, WEIGHT_DECIMALS[unit]))
}

export interface WeightFieldSet<K extends string> {
  unit: WeightUnit
  setUnit: (unit: WeightUnit) => void
  text: Record<K, string>
  /** Apply a keystroke-filtered edit. Returns false when the keystroke was rejected. */
  setText: (key: K, next: string) => boolean
  setGrams: (key: K, grams: number | null) => void
  clear: (key?: K) => void
  /** null when the field is empty (nothing to parse yet). */
  parse: (key: K, options?: ParseWeightOptions) => WeightParseResult | null
}

export function useWeightFields<K extends string>(
  keys: readonly K[],
  /** Grams to start with (e.g. re-weighing a return). Shown in the remembered unit. */
  initialGrams?: Partial<Record<K, number | null>>
): WeightFieldSet<K> {
  const [initial] = useState(() => {
    const unit = readUnit()
    const text = Object.fromEntries(
      keys.map((k) => {
        const g = initialGrams?.[k]
        return [k, g === null || g === undefined ? '' : gramsToText(g, unit)]
      })
    ) as Record<K, string>
    return { unit, text }
  })
  const [unit, setUnitState] = useState<WeightUnit>(initial.unit)
  const [text, setTextState] = useState<Record<K, string>>(initial.text)

  const setText = useCallback(
    (key: K, next: string): boolean => {
      if (!isKeystrokeAllowed(next, unit)) return false
      setTextState((prev) => ({ ...prev, [key]: next }))
      return true
    },
    [unit]
  )

  const setGrams = useCallback(
    (key: K, grams: number | null) => {
      setTextState((prev) => ({ ...prev, [key]: grams === null ? '' : gramsToText(grams, unit) }))
    },
    [unit]
  )

  const clear = useCallback(
    (key?: K) => {
      setTextState((prev) =>
        key ? { ...prev, [key]: '' } : (Object.fromEntries(keys.map((k) => [k, ''])) as Record<K, string>)
      )
    },
    [keys]
  )

  const setUnit = useCallback(
    (next: WeightUnit) => {
      if (next === unit) return
      setTextState((prev) => {
        const out = { ...prev }
        for (const k of Object.keys(prev) as K[]) {
          if (prev[k] === '') continue
          const parsed = parseWeightInput(prev[k], unit, { allowZero: true })
          // Unparseable leftovers (a lone ".") are dropped rather than carried across.
          out[k] = parsed.ok ? gramsToText(parsed.grams, next) : ''
        }
        return out
      })
      setUnitState(next)
      writeUnit(next)
    },
    [unit]
  )

  const parse = useCallback(
    (key: K, options?: ParseWeightOptions): WeightParseResult | null => {
      const t = text[key]
      if (t === undefined || t.trim() === '') return null
      return parseWeightInput(t, unit, options)
    },
    [text, unit]
  )

  return { unit, setUnit, text, setText, setGrams, clear, parse }
}
