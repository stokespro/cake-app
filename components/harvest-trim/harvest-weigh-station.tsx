'use client'

import { useCallback, useRef, useState } from 'react'
import { Ban, CheckCircle2 } from 'lucide-react'
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
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { resolveScan, type ScanResult, type ScanSource } from '@/actions/hangers'
import { HANGER_STATUS_META, lbText, plantsText } from './format'
import { HarvestOpenLoad } from './harvest-open-load'
import { HarvestWeighForm, type HarvestRecorded } from './harvest-weigh-form'
import { ScanInput } from './scan-input'
import { useTrimRun } from './use-trim-run'

export interface HarvestTally {
  hangers: number
  plants: number
  wetG: number
}

type View =
  | { kind: 'idle' }
  | { kind: 'loading'; code: string }
  | { kind: 'error'; code: string; message: string }
  | { kind: 'scan'; scan: ScanResult }

interface HarvestWeighStationProps {
  batchId: string
  batchName: string
  tally: HarvestTally
  /** Fresh batch totals after a recorded weight; null when the server could not read them back. */
  onRecorded: (totals: HarvestTally | null) => void
  onChangeBatch: (() => void) | null
}

/**
 * Scan a hanger, weigh it into the pinned batch, repeat. After a weight is recorded the screen goes
 * back to the scan field and the batch tally above it moves. The caller keys it by batch, so a
 * different batch starts from a clean screen.
 */
export function HarvestWeighStation({ batchId, batchName, tally, onRecorded, onChangeBatch }: HarvestWeighStationProps) {
  const run = useTrimRun()
  const [view, setView] = useState<View>({ kind: 'idle' })
  const [last, setLast] = useState<{ code: string; plants: number; wetG: number } | null>(null)
  const [batchProblem, setBatchProblem] = useState<string | null>(null)
  const [pendingScan, setPendingScan] = useState<{ code: string; source: ScanSource } | null>(null)

  // Whether the open panel holds unsaved input. A ref, so a scan handler never reads a stale value.
  const dirtyRef = useRef(false)
  const setDirty = useCallback((d: boolean) => {
    dirtyRef.current = d
  }, [])
  const currentCodeRef = useRef<string | null>(null)

  const resolve = useCallback(
    async (code: string, source: ScanSource) => {
      setView({ kind: 'loading', code })
      dirtyRef.current = false
      currentCodeRef.current = code
      const res = await run(resolveScan(code, source), { quiet: true })
      if (currentCodeRef.current !== code) return
      if (res.success) {
        currentCodeRef.current = res.data.hanger.code
        setView({ kind: 'scan', scan: res.data })
      } else {
        currentCodeRef.current = null
        setView({ kind: 'error', code, message: res.error })
      }
    },
    [run]
  )

  const handleScan = useCallback(
    (code: string, source: ScanSource) => {
      if (dirtyRef.current && currentCodeRef.current && code !== currentCodeRef.current) {
        setPendingScan({ code, source })
        return
      }
      if (dirtyRef.current && code === currentCodeRef.current) return
      void resolve(code, source)
    },
    [resolve]
  )

  function backToScan() {
    setView({ kind: 'idle' })
    dirtyRef.current = false
    currentCodeRef.current = null
    // Leave nothing focused, so the next wedge scan is read instead of typed into a field.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  }

  function handleRecorded(r: HarvestRecorded) {
    setLast({ code: r.code, plants: r.plants, wetG: r.wetG })
    onRecorded(r.totals)
    backToScan()
  }

  if (batchProblem) {
    return (
      <Card className="border-destructive/40">
        <CardContent className="space-y-3 py-6 text-center">
          <Ban className="mx-auto h-10 w-10 text-destructive" />
          <p className="text-base font-semibold">{batchProblem}</p>
          <div className="flex flex-wrap justify-center gap-2">
            {onChangeBatch && (
              <Button type="button" onClick={onChangeBatch}>
                Choose another batch
              </Button>
            )}
            <Button type="button" variant="outline" onClick={() => setBatchProblem(null)}>
              Try again
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  const busy = view.kind === 'loading'

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-1 py-4">
          <p className="text-sm text-muted-foreground">{batchName} so far</p>
          <p className="font-semibold">
            {tally.hangers} {tally.hangers === 1 ? 'hanger' : 'hangers'} &middot; {plantsText(tally.plants)} &middot;{' '}
            {lbText(tally.wetG)} wet
          </p>
          {last && (
            <p className="flex items-center gap-1.5 text-sm text-green-700 dark:text-green-400">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span>
                {last.code} recorded: {plantsText(last.plants)}, {lbText(last.wetG)}
              </span>
            </p>
          )}
        </CardContent>
      </Card>

      <ScanInput onScan={handleScan} enabled={!pendingScan} busy={busy} />

      {view.kind === 'loading' && (
        <Card>
          <CardContent className="py-6 text-center text-muted-foreground">Looking up {view.code}...</CardContent>
        </Card>
      )}

      {view.kind === 'error' && (
        <Card className="border-destructive/40">
          <CardContent className="space-y-3 py-6 text-center">
            <Ban className="mx-auto h-10 w-10 text-destructive" />
            <p className="text-base font-semibold">{view.message}</p>
            <Button type="button" variant="outline" onClick={() => void resolve(view.code, 'typed')}>
              Try again
            </Button>
          </CardContent>
        </Card>
      )}

      {view.kind === 'scan' && (
        <ScannedHanger
          key={view.scan.hanger.id}
          scan={view.scan}
          batchId={batchId}
          onRecorded={handleRecorded}
          onBatchProblem={setBatchProblem}
          onReread={() => void resolve(view.scan.hanger.code, 'typed')}
          onClose={backToScan}
          onDirtyChange={setDirty}
        />
      )}

      <AlertDialog open={pendingScan !== null} onOpenChange={(o) => !o && setPendingScan(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Switch to {pendingScan?.code}?</AlertDialogTitle>
            <AlertDialogDescription>
              {currentCodeRef.current} has entries that are not recorded. Switching throws them away.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep {currentCodeRef.current}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const p = pendingScan
                setPendingScan(null)
                if (p) void resolve(p.code, p.source)
              }}
            >
              Discard and switch
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

interface ScannedHangerProps {
  scan: ScanResult
  batchId: string
  onRecorded: (r: HarvestRecorded) => void
  onBatchProblem: (message: string) => void
  onReread: () => void
  onClose: () => void
  onDirtyChange: (dirty: boolean) => void
}

/**
 * What a scanned tag can do here. Whether it may start a load comes from canStartLoad, not from
 * nextStep: a tag whose last load is finished routes as 'closed_out' but is free to be weighed again.
 */
function ScannedHanger({
  scan,
  batchId,
  onRecorded,
  onBatchProblem,
  onReread,
  onClose,
  onDirtyChange,
}: ScannedHangerProps) {
  const { hanger, openLoad } = scan

  if (hanger.status !== 'active') {
    return (
      <Card className="border-destructive/40">
        <CardContent className="space-y-3 py-6 text-center">
          <Ban className="mx-auto h-10 w-10 text-destructive" />
          <p className="text-base font-semibold">
            {hanger.code} is {HANGER_STATUS_META[hanger.status].label.toLowerCase()} and cannot be used.
          </p>
          <p className="text-muted-foreground">Set it aside and scan another hanger.</p>
          <Button type="button" variant="outline" onClick={onClose}>
            Scan another
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (openLoad) {
    return (
      <HarvestOpenLoad
        scan={scan}
        load={openLoad}
        onChanged={onReread}
        onClose={onClose}
        onDirtyChange={onDirtyChange}
      />
    )
  }

  if (scan.canStartLoad) {
    return (
      <HarvestWeighForm
        scan={scan}
        batchId={batchId}
        onRecorded={onRecorded}
        onBatchProblem={onBatchProblem}
        onConflict={onReread}
        onCancel={onClose}
        onDirtyChange={onDirtyChange}
      />
    )
  }

  return (
    <Card>
      <CardContent className="space-y-3 py-6 text-center">
        <p className="font-semibold">{hanger.code} cannot start a load right now.</p>
        <Button type="button" variant="outline" onClick={onClose}>
          Scan another
        </Button>
      </CardContent>
    </Card>
  )
}
