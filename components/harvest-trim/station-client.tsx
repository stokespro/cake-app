'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Ban, ScanLine } from 'lucide-react'
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
import { resolveScan, type ScanEpisode, type ScanResult, type ScanSource } from '@/actions/hangers'
import {
  getTrimBoard,
  getTrimSettings,
  resolveVariance,
  voidLoad,
  type CheckOutResult,
} from '@/actions/harvest-trim'
import { listTrimStaff } from '@/actions/trim-staff'
import type { VarianceThresholds } from '@/lib/trim/variance'
import { CheckInPanel, type CheckInDone } from './checkin-panel'
import { DiscrepancyPanel } from './discrepancy-panel'
import { HangerDetailSheet } from './hanger-detail-panel'
import { IssuePanel } from './issue-panel'
import { LoadCard } from './load-card'
import { NewLoadPanel } from './new-load-panel'
import { NoAccess } from './no-access'
import { ReasonDialog } from './reason-dialog'
import { ScanInput } from './scan-input'
import { StationNoticeCard, type StationNotice } from './station-notice'
import type { PickerTrimmer } from './trimmer-picker'
import { useRefetchOnFocus } from './use-refetch-on-focus'
import { useTrimAccess } from './use-trim-access'
import { useTrimRun } from './use-trim-run'
import type { VarianceView } from './variance-banner'
import { HANGER_STATUS_META, lbText, plantsText, trimmerName } from './format'

const BASE = '/dashboard/harvest-trim'
const DEFAULT_THRESHOLDS: VarianceThresholds = { pctThreshold: 5, floorG: 25 }

type View =
  | { kind: 'idle' }
  | { kind: 'loading'; code: string }
  | { kind: 'error'; code: string; message: string; notFound: boolean }
  | { kind: 'scan'; scan: ScanResult }

function viewFromEpisode(ep: ScanEpisode, fallback: VarianceThresholds): VarianceView | null {
  if (ep.flowerG === null || ep.trimG === null || ep.stemsG === null) return null
  const remainingG = ep.remainingG ?? 0
  const varianceG = ep.varianceG ?? 0
  return {
    issuedG: ep.issuedG,
    flowerG: ep.flowerG,
    trimG: ep.trimG,
    stemsG: ep.stemsG,
    remainingG,
    processedG: ep.processedG ?? ep.issuedG - remainingG,
    returnedTotalG: ep.flowerG + ep.trimG + ep.stemsG,
    varianceG,
    variancePct: ep.variancePct ?? 0,
    direction: varianceG > 0 ? 'loss' : varianceG < 0 ? 'gain' : 'none',
    flagged: true,
    thresholdPct: ep.flagPctApplied ?? fallback.pctThreshold,
    thresholdFloorG: ep.flagFloorGApplied ?? fallback.floorG,
  }
}

/** Gate: the station is for the trim team. grow can look things up but not operate. */
export function StationClient() {
  const access = useTrimAccess()
  if (!access.ready) return null
  if (!access.canOperate) {
    return (
      <NoAccess
        title="The trim station is for the trim team"
        message="Your role can look up a hanger's status, but not check hangers in or out."
        backHref={`${BASE}/lookup`}
        backLabel="Look up a tag"
      />
    )
  }
  return <Station />
}

function Station() {
  const access = useTrimAccess()
  const run = useTrimRun()

  const [view, setView] = useState<View>({ kind: 'idle' })
  const [notice, setNotice] = useState<StationNotice | null>(null)
  const [staff, setStaff] = useState<PickerTrimmer[]>([])
  const [thresholds, setThresholds] = useState<VarianceThresholds>(DEFAULT_THRESHOLDS)
  const [historyCode, setHistoryCode] = useState<string | null>(null)
  const [voidOpen, setVoidOpen] = useState(false)
  const [reweigh, setReweigh] = useState(false)
  const [pendingScan, setPendingScan] = useState<{ code: string; source: ScanSource } | null>(null)
  const [flaggedBusy, setFlaggedBusy] = useState(false)

  // Whether the open panel holds unsaved input. A ref, so a scan handler never reads a stale value.
  const dirtyRef = useRef(false)
  const setDirty = useCallback((d: boolean) => {
    dirtyRef.current = d
  }, [])
  const currentCodeRef = useRef<string | null>(null)

  // ── Data the panels share: the roster with who holds what, and the flag thresholds ──
  const loadSupport = useCallback(async () => {
    const [staffRes, boardRes, settingsRes] = await Promise.all([
      run(listTrimStaff(), { quiet: true }),
      run(getTrimBoard(), { quiet: true }),
      run(getTrimSettings(), { quiet: true }),
    ])
    if (staffRes.success) {
      const out = new Map<string, number>()
      if (boardRes.success) for (const t of boardRes.data.trimmers) out.set(t.id, t.hangersOut)
      setStaff(staffRes.data.map((s) => ({ id: s.id, name: trimmerName(s), hangersOut: out.get(s.id) ?? 0 })))
    }
    if (settingsRes.success) {
      setThresholds({
        pctThreshold: settingsRes.data.variance_pct_threshold,
        floorG: settingsRes.data.variance_floor_g,
      })
    }
  }, [run])

  useEffect(() => {
    void loadSupport()
  }, [loadSupport])

  const resolve = useCallback(
    async (code: string, source: ScanSource, silent = false) => {
      // A silent re-read (tab refocus) keeps the screen as it is instead of flashing a spinner.
      if (!silent) {
        setView({ kind: 'loading', code })
        setReweigh(false)
        dirtyRef.current = false
        currentCodeRef.current = code
      }
      const res = await run(resolveScan(code, source), { quiet: true })
      if (silent && (!res.success || currentCodeRef.current !== code)) return
      if (res.success) {
        currentCodeRef.current = res.data.hanger.code
        setView({ kind: 'scan', scan: res.data })
      } else {
        currentCodeRef.current = null
        setView({ kind: 'error', code, message: res.error, notFound: res.code === 'NOT_FOUND' })
      }
    },
    [run]
  )

  /** Re-read the hanger on screen after something changed. */
  const refresh = useCallback(async () => {
    const code = currentCodeRef.current
    void loadSupport()
    if (code) await resolve(code, 'typed')
  }, [loadSupport, resolve])

  const handleScan = useCallback(
    (code: string, source: ScanSource) => {
      setNotice(null)
      if (dirtyRef.current && currentCodeRef.current && code !== currentCodeRef.current) {
        setPendingScan({ code, source })
        return
      }
      if (dirtyRef.current && code === currentCodeRef.current) return
      void resolve(code, source)
    },
    [resolve]
  )

  // Deep links: /station?code=H1B-042 (from the Overview, Lookup and batch pages).
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('code')
    if (code) void resolve(code, 'typed')
  }, [resolve])

  // Realtime is not in Phase 1: catch up whenever the tab comes back into view.
  useRefetchOnFocus(() => {
    void loadSupport()
    if (!dirtyRef.current && currentCodeRef.current) void resolve(currentCodeRef.current, 'typed', true)
  })

  function finish(next: StationNotice) {
    setNotice(next)
    setView({ kind: 'idle' })
    setReweigh(false)
    dirtyRef.current = false
    currentCodeRef.current = null
    void loadSupport()
  }

  function reissueAction(code: string): StationNotice['action'] {
    return {
      label: `Reissue ${code} now`,
      onClick: () => {
        setNotice(null)
        void resolve(code, 'typed')
      },
    }
  }

  function handleIssued(code: string, r: CheckOutResult) {
    finish({
      tone: 'success',
      title: `${code} issued to ${r.trimmerName}`,
      lines: [`${lbText(r.issuedG)}${r.issuedPlantCount !== null ? ` · ${plantsText(r.issuedPlantCount)}` : ''}`],
    })
  }

  function handleCheckInDone(code: string, trimmer: string, done: CheckInDone) {
    const { result } = done
    const lines: string[] = []
    if (result.returnKind === 'unfinished' || done.loadStatus === 'partial') {
      lines.push(`${plantsText(result.remainingPlants)} left on it, ${lbText(result.remainingG)} remaining.`)
    }
    lines.push(`${lbText(result.totalG)} came back from ${trimmer} (flower, trim and stems).`)
    if (access.canSeePay && result.payAmount !== null && !done.accepted) {
      lines.push(`Earned ${result.payAmount.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}.`)
    }

    if (done.loadStatus === 'returned') {
      finish({
        tone: 'warning',
        title: `${code} left flagged`,
        lines: [
          'It is in the flagged queue on the Overview. It cannot be reissued, and pay waits, until it is resolved.',
        ],
      })
      return
    }
    if (done.loadStatus === 'partial') {
      finish({
        tone: 'success',
        title: done.accepted ? `${code} accepted, back unfinished` : `${code} checked in unfinished`,
        lines,
        action: reissueAction(code),
      })
      return
    }
    finish({
      tone: 'success',
      title: done.accepted ? `${code} accepted and reconciled` : `${code} checked in and reconciled`,
      lines,
    })
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const busy = view.kind === 'loading'

  return (
    <div className="space-y-4">
      {notice && <StationNoticeCard notice={notice} onDismiss={() => setNotice(null)} />}

      <ScanInput onScan={handleScan} enabled={!pendingScan} busy={busy} />

      {view.kind === 'idle' && !notice && <IdleHelp />}

      {view.kind === 'loading' && (
        <Card>
          <CardContent className="py-8 text-center text-base text-muted-foreground">Looking up {view.code}...</CardContent>
        </Card>
      )}

      {view.kind === 'error' && (
        <Card className="border-destructive/40">
          <CardContent className="space-y-3 py-6 text-center">
            <Ban className="mx-auto h-10 w-10 text-destructive" />
            <p className="text-base font-semibold">{view.message}</p>
            {view.notFound && (
              <p className="text-muted-foreground">
                If this tag is new, add it on the Hangers page first (Import tab).
              </p>
            )}
            <div className="flex flex-wrap justify-center gap-2">
              <Button type="button" variant="outline" onClick={() => void resolve(view.code, 'typed')}>
                Try again
              </Button>
              {view.notFound && (
                <Button asChild variant="outline">
                  <Link href={`${BASE}/hangers`}>Go to Hangers</Link>
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {view.kind === 'scan' && (
        <ScanFlow
          scan={view.scan}
          staff={staff}
          thresholds={thresholds}
          reweigh={reweigh}
          setReweigh={setReweigh}
          canVoidPartial={access.isAdmin}
          flaggedBusy={flaggedBusy}
          onHistory={() => setHistoryCode(view.scan.hanger.code)}
          onVoid={() => setVoidOpen(true)}
          onDirtyChange={setDirty}
          onIssued={(r) => handleIssued(view.scan.hanger.code, r)}
          onChanged={() => void refresh()}
          onCheckInDone={(done) => {
            const ep = view.scan.checkout ?? view.scan.openLoad?.episodes.filter((e) => e.status === 'returned').slice(-1)[0]
            handleCheckInDone(view.scan.hanger.code, ep?.trimmerName ?? 'the trimmer', done)
          }}
          onReleased={() => {
            setNotice({ tone: 'info', title: `${view.scan.hanger.code} released`, lines: ['It is back on the shelf. Issue it again below.'] })
            void refresh()
          }}
          onAcceptFlagged={async (checkoutId, reason) => {
            setFlaggedBusy(true)
            const res = await run(resolveVariance({ checkoutId, reason }))
            setFlaggedBusy(false)
            if (!res.success) return
            const code = view.scan.hanger.code
            if (res.data.loadStatus === 'partial') {
              finish({
                tone: 'success',
                title: `${code} accepted, back unfinished`,
                action: reissueAction(code),
              })
            } else {
              finish({ tone: 'success', title: `${code} accepted and reconciled` })
            }
          }}
          onLeaveFlagged={() =>
            finish({
              tone: 'warning',
              title: `${view.scan.hanger.code} is still flagged`,
              lines: ['It stays in the flagged queue until someone resolves it.'],
            })
          }
        />
      )}

      <HangerDetailSheet code={historyCode} onOpenChange={(o) => !o && setHistoryCode(null)} />

      <ReasonDialog
        open={voidOpen}
        onOpenChange={setVoidOpen}
        title="Void this load?"
        description="Cancels the load and drops it from every total. The tag is free again. This is logged."
        chips={['Scanned the wrong hanger', 'Entered by mistake', 'Plants discarded', 'Other']}
        confirmLabel="Void load"
        destructive
        onConfirm={async (reason) => {
          if (view.kind !== 'scan' || !view.scan.openLoad) return false
          const code = view.scan.hanger.code
          const res = await run(voidLoad({ loadId: view.scan.openLoad.id, reason }))
          if (res.success) {
            finish({ tone: 'info', title: `${code} load voided`, lines: ['The tag is free for a new load.'] })
          }
          return res.success
        }}
      />

      <AlertDialog open={pendingScan !== null} onOpenChange={(o) => !o && setPendingScan(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Switch to {pendingScan?.code}?</AlertDialogTitle>
            <AlertDialogDescription>
              You have weights typed in for {currentCodeRef.current} that are not saved. Switching throws them away.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep working on {currentCodeRef.current}</AlertDialogCancel>
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

function IdleHelp() {
  return (
    <Card>
      <CardContent className="space-y-3 py-5">
        <div className="flex items-center gap-2">
          <ScanLine className="h-5 w-5 text-primary" />
          <p className="font-semibold">One scan does the right thing</p>
        </div>
        <ul className="space-y-2 text-base text-muted-foreground">
          <li>
            <strong className="text-foreground">Free or drying tag</strong>: start a load, add the dry weight, pick the
            trimmer.
          </li>
          <li>
            <strong className="text-foreground">Dried tag</strong>: pick the trimmer to issue it.
          </li>
          <li>
            <strong className="text-foreground">Tag with a trimmer</strong>: check it in as Finished or Unfinished.
          </li>
          <li>
            <strong className="text-foreground">Unfinished tag</strong>: reissue it to the same or another trimmer.
          </li>
        </ul>
        <p className="text-sm text-muted-foreground">
          Not sure what a tag is? Use{' '}
          <Link href={`${BASE}/lookup`} className="underline">
            Look up a tag
          </Link>
          .
        </p>
      </CardContent>
    </Card>
  )
}

interface ScanFlowProps {
  scan: ScanResult
  staff: PickerTrimmer[]
  thresholds: VarianceThresholds
  reweigh: boolean
  setReweigh: (v: boolean) => void
  canVoidPartial: boolean
  flaggedBusy: boolean
  onHistory: () => void
  onVoid: () => void
  onDirtyChange: (dirty: boolean) => void
  onIssued: (r: CheckOutResult) => void
  onChanged: () => void
  onCheckInDone: (done: CheckInDone) => void
  onReleased: () => void
  onAcceptFlagged: (checkoutId: string, reason: string) => void | Promise<void>
  onLeaveFlagged: () => void
}

/** Everything under the scan field. The branch is chosen by the load's status; "start a new load" by canStartLoad only. */
function ScanFlow({
  scan,
  staff,
  thresholds,
  reweigh,
  setReweigh,
  canVoidPartial,
  flaggedBusy,
  onHistory,
  onVoid,
  onDirtyChange,
  onIssued,
  onChanged,
  onCheckInDone,
  onReleased,
  onAcceptFlagged,
  onLeaveFlagged,
}: ScanFlowProps) {
  const access = useTrimAccess()
  const { hanger, openLoad } = scan

  if (hanger.status !== 'active') {
    const meta = HANGER_STATUS_META[hanger.status]
    return (
      <Card className="border-destructive/40">
        <CardContent className="space-y-3 py-6">
          <p className="font-mono text-2xl font-bold">{hanger.code}</p>
          <p className="text-base font-semibold text-destructive">
            This hanger is {meta.label.toLowerCase()}. It cannot take new loads.
          </p>
          {hanger.notes && <p className="text-muted-foreground">Note: {hanger.notes}</p>}
          <Button type="button" variant="outline" onClick={onHistory}>
            See its history
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (openLoad) {
    const canVoid =
      (openLoad.status === 'hung' || openLoad.status === 'dried') || (openLoad.status === 'partial' && canVoidPartial)
    const card = (
      <LoadCard scan={scan} load={openLoad} canVoid={canVoid && access.canOperate} onHistory={onHistory} onVoid={onVoid} />
    )

    switch (openLoad.status) {
      case 'hung':
      case 'dried':
      case 'partial':
        return (
          <div className="space-y-4">
            {card}
            <IssuePanel
              key={`${openLoad.id}:${openLoad.status}`}
              hangerCode={hanger.code}
              load={openLoad}
              staff={staff}
              onIssued={onIssued}
              onChanged={onChanged}
              onDirtyChange={onDirtyChange}
            />
          </div>
        )

      case 'checked_out':
        return (
          <div className="space-y-4">
            {card}
            {scan.checkout ? (
              <CheckInPanel
                key={scan.checkout.id}
                hangerCode={hanger.code}
                episode={scan.checkout}
                mode="checkin"
                thresholds={thresholds}
                onDone={onCheckInDone}
                onReleased={onReleased}
                onDirtyChange={onDirtyChange}
              />
            ) : (
              <MissingEpisode onRefresh={onChanged} />
            )}
          </div>
        )

      case 'returned': {
        const flagged = [...openLoad.episodes].reverse().find((e) => e.status === 'returned') ?? null
        const flaggedView = flagged ? viewFromEpisode(flagged, thresholds) : null
        if (!flagged || !flaggedView) return <div className="space-y-4">{card}<MissingEpisode onRefresh={onChanged} /></div>
        return (
          <div className="space-y-4">
            {card}
            {reweigh ? (
              <CheckInPanel
                key={`${flagged.id}:reweigh`}
                hangerCode={hanger.code}
                episode={flagged}
                mode="correct"
                thresholds={thresholds}
                onDone={onCheckInDone}
                onReleased={onReleased}
                onCancel={() => setReweigh(false)}
                onDirtyChange={onDirtyChange}
              />
            ) : (
              <DiscrepancyPanel
                hangerCode={hanger.code}
                trimmerName={flagged.trimmerName}
                kind={flagged.returnKind ?? 'complete'}
                view={flaggedView}
                busy={flaggedBusy}
                onReweigh={() => setReweigh(true)}
                onAccept={(reason) => void onAcceptFlagged(flagged.id, reason)}
                onLeaveFlagged={onLeaveFlagged}
                leaveLabel="Leave flagged for now"
              />
            )}
          </div>
        )
      }

      default:
        break
    }
  }

  // No open load. Starting one is gated on canStartLoad, NOT on nextStep:
  // a finished hanger routes as 'closed_out' and can still take a new load.
  if (scan.canStartLoad) {
    return (
      <div className="space-y-4">
        {scan.lastClosedLoad && (
          <LoadCard scan={scan} load={scan.lastClosedLoad} canVoid={false} onHistory={onHistory} onVoid={onVoid} />
        )}
        <NewLoadPanel scan={scan} onCreated={onChanged} onDirtyChange={onDirtyChange} />
      </div>
    )
  }

  return (
    <Card>
      <CardContent className="space-y-3 py-6">
        <p className="font-mono text-2xl font-bold">{hanger.code}</p>
        <p className="text-base">Nothing to do with this tag right now.</p>
        <Button type="button" variant="outline" onClick={onHistory}>
          See its history
        </Button>
      </CardContent>
    </Card>
  )
}

function MissingEpisode({ onRefresh }: { onRefresh: () => void }) {
  return (
    <Card>
      <CardContent className="space-y-3 py-6 text-center">
        <p className="text-base font-semibold">The details for this hanger did not load.</p>
        <Button type="button" variant="outline" onClick={onRefresh}>
          Reload
        </Button>
      </CardContent>
    </Card>
  )
}
