'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ErrorState } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { getTrimSettings, updateTrimSettings } from '@/actions/harvest-trim'
import type { TrimSettings } from '@/types/harvest-trim'
import { gramsToLb } from '@/lib/units'
import { whenText } from './format'
import { useTrimAccess } from './use-trim-access'
import { useTrimRun } from './use-trim-run'

const PCT_KEYSTROKE = /^\d{0,3}\.?\d{0,2}$/
const GRAMS_KEYSTROKE = /^\d{0,5}\.?\d{0,2}$/

/**
 * The flag rule: a return is flagged only when it is off by MORE than the
 * percent AND MORE than the grams. The floor stops a small hanger from flagging
 * on scale noise; the percent stops a big hanger hiding a large loss.
 */
export function SettingsClient() {
  const access = useTrimAccess()
  const run = useTrimRun()
  const [settings, setSettings] = useState<TrimSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pct, setPct] = useState('')
  const [floor, setFloor] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const res = await run(getTrimSettings(), { quiet: true })
    if (res.success) {
      setSettings(res.data)
      setPct(String(res.data.variance_pct_threshold))
      setFloor(String(res.data.variance_floor_g))
      setError(null)
    } else {
      setError(res.error)
    }
  }, [run])

  useEffect(() => {
    void load()
  }, [load])

  if (error && !settings) return <ErrorState title="Could not load settings" message={error} onRetry={() => void load()} />
  if (!settings) return <p className="py-12 text-center text-muted-foreground">Loading...</p>

  const pctNum = pct === '' ? null : Number(pct)
  const floorNum = floor === '' ? null : Number(floor)
  const pctValid = pctNum !== null && Number.isFinite(pctNum) && pctNum >= 0 && pctNum <= 100
  const floorValid = floorNum !== null && Number.isFinite(floorNum) && floorNum >= 0 && floorNum <= 10000
  const changed = pctNum !== settings.variance_pct_threshold || floorNum !== settings.variance_floor_g
  const canEdit = access.isAdmin

  async function save() {
    if (!pctValid || !floorValid || pctNum === null || floorNum === null) return
    setBusy(true)
    const res = await run(updateTrimSettings({ variancePctThreshold: pctNum, varianceFloorG: floorNum }))
    setBusy(false)
    if (res.success) {
      toast.success('Settings saved')
      setSettings(res.data)
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-5 pt-5">
          <div>
            <h2 className="text-lg font-semibold">Variance flag</h2>
            <p className="text-muted-foreground">
              When a trimmer returns a hanger, the flower, trim, stems and anything left on the hanger should add back up
              to what was issued. A hanger is flagged only when it is off by <strong>more than the percent</strong> and{' '}
              <strong>more than the grams</strong>, in either direction.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="settings-pct">
              Percent off
            </Label>
            <div className="relative">
              <Input
                id="settings-pct"
                type="text"
                inputMode="decimal"
                value={pct}
                disabled={!canEdit || busy}
                onChange={(e) => PCT_KEYSTROKE.test(e.target.value) && setPct(e.target.value)}
                className="h-12 pr-12 text-center text-lg font-semibold md:text-xl"
              />
              <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-base text-muted-foreground">%</span>
            </div>
            {pct !== '' && !pctValid && <p className="text-sm font-medium text-destructive">Enter a percent from 0 to 100.</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="settings-floor">
              Grams off
            </Label>
            <div className="relative">
              <Input
                id="settings-floor"
                type="text"
                inputMode="decimal"
                value={floor}
                disabled={!canEdit || busy}
                onChange={(e) => GRAMS_KEYSTROKE.test(e.target.value) && setFloor(e.target.value)}
                className="h-12 pr-12 text-center text-lg font-semibold md:text-xl"
              />
              <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-base text-muted-foreground">g</span>
            </div>
            {floorValid && floorNum !== null ? (
              <p className="text-center text-sm text-muted-foreground">= {gramsToLb(floorNum).toFixed(3)} lb</p>
            ) : (
              <p className="text-sm font-medium text-destructive">Enter grams from 0 to 10,000.</p>
            )}
          </div>

          {pctValid && floorValid && (
            <p className="rounded-lg bg-muted p-3">
              With these settings a hanger is flagged when it is off by more than <strong>{pctNum}%</strong> and more than{' '}
              <strong>{floorNum} g</strong>.
            </p>
          )}

          {canEdit ? (
            <Button
              type="button"
              className="h-12 w-full text-base font-semibold"
              disabled={!changed || !pctValid || !floorValid || busy}
              onClick={save}
            >
              {busy ? 'Saving...' : 'Save settings'}
            </Button>
          ) : (
            <p className="rounded-lg border bg-muted/40 p-3 text-sm">
              Only an admin or manager can change these. They apply to the next check-in; hangers already returned keep
              the rule they were judged under.
            </p>
          )}

          <p className="text-xs text-muted-foreground">Last changed {whenText(settings.updated_at)}.</p>
        </CardContent>
      </Card>
    </div>
  )
}
