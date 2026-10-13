'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { format } from 'date-fns'
import { AlertTriangle, Check, CheckCircle2, ChevronsUpDown, Plus, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  declareHarvestBatches,
  editDeclaredBatch,
  getCycleBatches,
  listHarvestCycles,
  listTrimStrains,
  removeDeclaredBatch,
  type CycleBatch,
  type CycleOption,
  type TrimStrainOption,
} from '@/actions/harvest-trim'
import { createBatchNameAllocator, deriveStrainAbbreviation, formatBatchName } from '@/lib/trim/batch-name'
import { batchColor, dateOnlyText } from './format'
import { useRefetchOnFocus } from './use-refetch-on-focus'
import { useTrimRun } from './use-trim-run'

const HUB = '/dashboard/harvest-trim'
const MAX_NAME_LENGTH = 64

/**
 * How a declare step ended. The cultivation dialogs show a short note for each;
 * none of them blocks the stage advance (declaring is a convenience that the wet-weight
 * gate enforces later, not a gate on the advance itself).
 */
export type BatchStepOutcome =
  | { kind: 'declared'; names: string[] }
  | { kind: 'existing'; count: number }
  | { kind: 'skipped' }

interface DraftRow {
  key: string
  strainId: string
  name: string
}

interface Problem {
  message: string
  suggestion: string | null
}

export interface DeclareHarvestBatchesFormProps {
  cycleId: string
  /**
   * The room's number, when the caller already has it. Leave it (or `harvestDate`) undefined and the
   * form looks both up from the cycle list instead.
   */
  roomNumber?: number | null
  /** The cycle's harvest_date as the caller last saw it; null means the cycle has none. Never written back. */
  harvestDate?: string | null
  /** Called when the user finishes: declared batches, continued past existing ones, or skipped. */
  onDone: (outcome: BatchStepOutcome) => void
  /** Overrides the label of the "skip" button (the hub calls it "Close"). */
  skipLabel?: string
}

/** "0722-F2-CM-3" -> "0722-F2-CM": the base a split suffix is added to. Free-form names are left alone. */
function splitBase(name: string): string {
  const trimmed = name.trim()
  const m = /^(\d{4}-F\d+-[A-Za-z0-9]+)-\d+$/.exec(trimmed)
  return m ? m[1] : trimmed
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many
}

function loadTotal(b: CycleBatch): number {
  return Object.values(b.counts).reduce<number>((sum, n) => sum + (n ?? 0), 0)
}

/** The batch name a DUPLICATE_NAME error is about: "a batch named X already exists (...)". */
function clashedName(message: string, rows: DraftRow[]): string | null {
  const m = /batch named (.+?) already exists/i.exec(message)
  if (m) return m[1].trim()
  const lower = message.toLowerCase()
  let best: string | null = null
  for (const r of rows) {
    const n = r.name.trim()
    if (n && lower.includes(n.toLowerCase()) && (best === null || n.length > best.length)) best = n
  }
  return best
}

/**
 * "Declare the strains coming out of this room." A searchable multi-select over every strain (no
 * availability filter: a room may or may not hold every strain we grow). Each ticked strain adds an
 * editable batch row pre-filled MMDD-F{room}-{ABBR}; "+ Split" adds another batch of the same strain
 * (-2, -3). Declaring is idempotent per cycle, so a retry is always safe.
 *
 * It writes only to `batches`. The harvest date comes from the cycle and is never written back to
 * room_cycles (cycle dates are authoritative).
 */
export function DeclareHarvestBatchesForm({
  cycleId,
  roomNumber: roomNumberHint,
  harvestDate: harvestDateHint,
  onDone,
  skipLabel,
}: DeclareHarvestBatchesFormProps) {
  const run = useTrimRun()

  const [strains, setStrains] = useState<TrimStrainOption[] | null>(null)
  const [declared, setDeclared] = useState<CycleBatch[]>([])
  const [lookup, setLookup] = useState<CycleOption | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [rows, setRows] = useState<DraftRow[]>([])
  const [pickerOpen, setPickerOpen] = useState(true)
  // Names the server told us are taken (on another cycle or strain). Kept so the row keeps its inline
  // error and every later suggestion steps around them.
  const [taken, setTaken] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const [renaming, setRenaming] = useState<{ id: string; value: string; error: string | null } | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [busyBatch, setBusyBatch] = useState<string | null>(null)
  const [manageError, setManageError] = useState<string | null>(null)

  const keyRef = useRef(0)
  const needsLookup = roomNumberHint === undefined || harvestDateHint === undefined

  const load = useCallback(async () => {
    const [strainsRes, batchesRes, cyclesRes] = await Promise.all([
      run(listTrimStrains(cycleId), { quiet: true }),
      run(getCycleBatches(cycleId), { quiet: true }),
      needsLookup ? run(listHarvestCycles(), { quiet: true }) : Promise.resolve(null),
    ])
    if (!strainsRes.success) {
      setLoadError((prev) => prev ?? strainsRes.error)
      return
    }
    setStrains(strainsRes.data)
    if (batchesRes.success) setDeclared(batchesRes.data)
    if (cyclesRes?.success) setLookup(cyclesRes.data.find((c) => c.id === cycleId) ?? null)
    setLoadError(null)
  }, [cycleId, needsLookup, run])

  useEffect(() => {
    void load()
  }, [load])
  useRefetchOnFocus(() => void load())

  const roomNumber = roomNumberHint !== undefined ? roomNumberHint : (lookup?.roomNumber ?? null)
  const cycleHarvestDate = harvestDateHint !== undefined ? harvestDateHint : (lookup?.harvestDate ?? null)
  const todayIso = useMemo(() => format(new Date(), 'yyyy-MM-dd'), [])
  const nameDate = cycleHarvestDate ?? todayIso

  const strainById = useMemo(() => new Map((strains ?? []).map((s) => [s.id, s])), [strains])

  const declaredStrainIds = useMemo(() => {
    const ids = new Set<string>()
    for (const s of strains ?? []) if (s.hasBatchInCycle) ids.add(s.id)
    for (const b of declared) if (b.strainId) ids.add(b.strainId)
    return ids
  }, [strains, declared])

  const declaredNames = useMemo(() => declared.map((b) => b.name), [declared])

  /** MMDD-F{room}-{ABBR} for a strain. Falls back to the bare abbreviation if the room is unknown. */
  const suggestedBase = useCallback(
    (strain: TrimStrainOption): string => {
      const { abbreviation } = deriveStrainAbbreviation({
        strainName: strain.name,
        strainBatches: strain.latestBatchName
          ? [{ name: strain.latestBatchName, createdAt: strain.latestBatchCreatedAt }]
          : undefined,
      })
      try {
        return formatBatchName({ harvestDate: nameDate, roomNumber: roomNumber ?? 0, abbreviation })
      } catch {
        return abbreviation
      }
    },
    [nameDate, roomNumber]
  )

  /** Every name we know is spoken for, optionally ignoring one row (the one being re-suggested). */
  const knownNames = useCallback(
    (ignoreKey?: string): string[] => [
      ...declaredNames,
      ...taken,
      ...rows.filter((r) => r.key !== ignoreKey).map((r) => r.name.trim()),
    ],
    [declaredNames, taken, rows]
  )

  const addRow = useCallback(
    (strainId: string, base: string, afterKey?: string) => {
      const key = `row-${keyRef.current++}`
      setRows((prev) => {
        const name = createBatchNameAllocator([
          ...declaredNames,
          ...taken,
          ...prev.map((r) => r.name.trim()),
        ]).allocate(base)
        const row: DraftRow = { key, strainId, name }
        if (afterKey === undefined) return [...prev, row]
        const at = prev.findIndex((r) => r.key === afterKey)
        return at < 0 ? [...prev, row] : [...prev.slice(0, at + 1), row, ...prev.slice(at + 1)]
      })
      setSubmitError(null)
    },
    [declaredNames, taken]
  )

  function toggleStrain(strain: TrimStrainOption) {
    if (declaredStrainIds.has(strain.id)) return
    if (rows.some((r) => r.strainId === strain.id)) {
      setRows((prev) => prev.filter((r) => r.strainId !== strain.id))
    } else {
      addRow(strain.id, suggestedBase(strain))
    }
  }

  function splitRow(row: DraftRow) {
    addRow(row.strainId, splitBase(row.name), row.key)
  }

  function renameRow(key: string, name: string) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, name } : r)))
    setSubmitError(null)
  }

  function removeRow(key: string) {
    setRows((prev) => prev.filter((r) => r.key !== key))
    setSubmitError(null)
  }

  // Inline problems, computed from what we know. Server-reported clashes land in `taken`, so they
  // show up here too.
  const problems = useMemo(() => {
    const out = new Map<string, Problem>()
    const declaredLower = new Set(declaredNames.map((n) => n.toLowerCase()))
    const takenLower = new Set(taken.map((n) => n.toLowerCase()))
    const seen = new Map<string, string>()
    for (const r of rows) {
      const name = r.name.trim()
      const lower = name.toLowerCase()
      const suggest = () =>
        createBatchNameAllocator(knownNames(r.key)).allocate(splitBase(name) || 'BATCH')
      if (!name) {
        out.set(r.key, { message: 'Give this batch a name.', suggestion: null })
      } else if (name.length > MAX_NAME_LENGTH) {
        out.set(r.key, { message: `Names can be up to ${MAX_NAME_LENGTH} characters.`, suggestion: null })
      } else if (declaredLower.has(lower)) {
        out.set(r.key, { message: `${name} is already declared on this cycle.`, suggestion: suggest() })
      } else if (takenLower.has(lower)) {
        out.set(r.key, {
          message: `A batch named ${name} already exists on another cycle or strain. Batch names have to be unique.`,
          suggestion: suggest(),
        })
      } else if (seen.has(lower)) {
        out.set(r.key, { message: 'Another row has this name.', suggestion: suggest() })
      }
      if (name) seen.set(lower, r.key)
    }
    return out
  }, [rows, declaredNames, taken, knownNames])

  const count = rows.length
  const canSubmit = count > 0 && problems.size === 0 && !submitting && strains !== null

  async function submit() {
    if (!canSubmit) return
    setSubmitting(true)
    setSubmitError(null)
    const res = await run(
      declareHarvestBatches({
        cycleId,
        batches: rows.map((r) => ({
          strainId: r.strainId,
          name: r.name.trim(),
          // Only sent when the cycle has no harvest date; otherwise the database reads the live one,
          // so a stale date on screen can never override it.
          ...(cycleHarvestDate ? {} : { harvestDate: todayIso }),
        })),
      }),
      { quiet: true }
    )
    setSubmitting(false)

    if (res.success) {
      const names = [...res.data.created, ...res.data.skipped].map((b) => b.name)
      setRows([])
      void load()
      onDone({ kind: 'declared', names })
      return
    }
    if (res.code === 'DUPLICATE_NAME') {
      const name = clashedName(res.error, rows)
      if (name) {
        setTaken((prev) => (prev.some((n) => n.toLowerCase() === name.toLowerCase()) ? prev : [...prev, name]))
        // The nearest bad row is in view; nothing was written (declaring is all or nothing).
        return
      }
    }
    setSubmitError(res.error)
  }

  async function saveRename() {
    if (!renaming) return
    const name = renaming.value.trim()
    const current = declared.find((b) => b.id === renaming.id)
    if (!name) return setRenaming({ ...renaming, error: 'Give this batch a name.' })
    if (name.length > MAX_NAME_LENGTH) {
      return setRenaming({ ...renaming, error: `Names can be up to ${MAX_NAME_LENGTH} characters.` })
    }
    if (current && name === current.name) return setRenaming(null)
    setBusyBatch(renaming.id)
    const res = await run(editDeclaredBatch({ batchId: renaming.id, name }), { quiet: true })
    setBusyBatch(null)
    if (res.success) {
      setRenaming(null)
      setManageError(null)
      void load()
      return
    }
    if (res.code === 'DUPLICATE_NAME') {
      const alt = createBatchNameAllocator([...declaredNames, ...taken, ...rows.map((r) => r.name), name]).allocate(
        splitBase(name)
      )
      setTaken((prev) => [...prev, name])
      setRenaming({
        ...renaming,
        error: `A batch named ${name} already exists. Batch names have to be unique. Try ${alt}.`,
      })
      return
    }
    setRenaming({ ...renaming, error: res.error })
  }

  async function confirmRemove(batch: CycleBatch) {
    setBusyBatch(batch.id)
    const res = await run(removeDeclaredBatch(batch.id), { quiet: true })
    setBusyBatch(null)
    if (res.success) {
      setRemoving(null)
      setManageError(null)
      void load()
    } else {
      setRemoving(null)
      setManageError(res.error)
    }
  }

  function skip() {
    onDone(declared.length > 0 ? { kind: 'existing', count: declared.length } : { kind: 'skipped' })
  }

  if (loadError && strains === null) {
    return (
      <div className="space-y-3 rounded-lg border border-destructive/30 p-4 text-center">
        <p className="text-destructive">{loadError}</p>
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
          <Button type="button" variant="outline" className="h-14" onClick={() => void load()}>
            Try again
          </Button>
          <Button type="button" variant="ghost" className="h-14" onClick={skip}>
            {skipLabel ?? 'Skip for now'}
          </Button>
        </div>
      </div>
    )
  }
  if (strains === null) return <p className="py-8 text-center text-muted-foreground">Loading strains...</p>

  const skipText =
    skipLabel ?? (count > 0 ? "Skip, don't declare these" : declared.length > 0 ? 'Continue' : 'Skip for now')

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold">Declare the strains coming out of this room</h3>
        <p className="text-sm text-muted-foreground">
          {roomNumber !== null ? `Room ${roomNumber} · ` : ''}
          {cycleHarvestDate
            ? `Harvest ${dateOnlyText(cycleHarvestDate)}`
            : 'This cycle has no harvest date yet, so names use today'}
          . Tick every strain that was in the room. Each one gets its own batch, and the names can be changed.
        </p>
      </div>

      {/* Already declared */}
      {declared.length > 0 && (
        <section aria-label="Already declared" className="space-y-2">
          <p className="text-sm font-medium text-muted-foreground">
            Already declared <span className="font-normal">({declared.length})</span>
          </p>
          <ul className="space-y-2">
            {declared.map((b) => {
              const loads = loadTotal(b)
              const editable = !b.isActive && loads === 0
              const isRenaming = renaming?.id === b.id
              const isRemoving = removing === b.id
              const busy = busyBatch === b.id
              return (
                <li key={b.id} className="rounded-lg border bg-card p-3">
                  <div className="flex items-center gap-3">
                    <span className={cn('h-10 w-2 shrink-0 rounded-full', batchColor(b.strainId ?? b.id))} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-base font-semibold">{b.name}</p>
                      <p className="truncate text-sm text-muted-foreground">
                        {b.strainName ?? 'No strain'} &middot; {loads} {plural(loads, 'hanger', 'hangers')}
                      </p>
                    </div>
                    <CheckCircle2 className="h-5 w-5 shrink-0 text-green-600" aria-label="Declared" />
                  </div>

                  {isRenaming && renaming && (
                    <div className="mt-3 space-y-2">
                      <Input
                        value={renaming.value}
                        onChange={(e) => setRenaming({ ...renaming, value: e.target.value, error: null })}
                        aria-label={`New name for ${b.name}`}
                        aria-invalid={renaming.error !== null}
                        autoCapitalize="characters"
                        autoCorrect="off"
                        spellCheck={false}
                        className="h-14 font-mono text-base"
                      />
                      {renaming.error && (
                        <p role="alert" className="text-sm font-medium text-red-700 dark:text-red-300">
                          {renaming.error}
                        </p>
                      )}
                      <div className="flex gap-2">
                        <Button type="button" className="h-14 flex-1" disabled={busy} onClick={() => void saveRename()}>
                          {busy ? 'Saving...' : 'Save name'}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          className="h-14 flex-1"
                          disabled={busy}
                          onClick={() => setRenaming(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}

                  {isRemoving && (
                    <div className="mt-3 space-y-2">
                      <p className="text-sm font-medium">Remove {b.name}? Nothing has been weighed into it.</p>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          variant="destructive"
                          className="h-14 flex-1"
                          disabled={busy}
                          onClick={() => void confirmRemove(b)}
                        >
                          {busy ? 'Removing...' : 'Remove it'}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          className="h-14 flex-1"
                          disabled={busy}
                          onClick={() => setRemoving(null)}
                        >
                          Keep it
                        </Button>
                      </div>
                    </div>
                  )}

                  {editable && !isRenaming && !isRemoving && (
                    <div className="mt-3 flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        className="h-14 flex-1"
                        onClick={() => {
                          setManageError(null)
                          setRemoving(null)
                          setRenaming({ id: b.id, value: b.name, error: null })
                        }}
                      >
                        Rename
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-14 flex-1"
                        onClick={() => {
                          setManageError(null)
                          setRenaming(null)
                          setRemoving(b.id)
                        }}
                      >
                        Remove
                      </Button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
          {manageError && (
            <p role="alert" className="text-sm font-medium text-red-700 dark:text-red-300">
              {manageError}
            </p>
          )}
        </section>
      )}

      {/* Strain picker */}
      <section aria-label="Strains" className="space-y-2">
        {pickerOpen ? (
          <div className="overflow-hidden rounded-lg border">
            <Command
              className="h-auto"
              filter={(_value, search, keywords) => {
                const q = search.trim().toLowerCase()
                return !q || (keywords?.[0] ?? '').toLowerCase().includes(q) ? 1 : 0
              }}
            >
              <CommandInput placeholder="Search strains" className="h-14 text-base" />
              <CommandList className="max-h-72">
                <CommandEmpty>No strain matches that search.</CommandEmpty>
                <CommandGroup>
                  {strains.map((s) => {
                    const alreadyDeclared = declaredStrainIds.has(s.id)
                    const ticked = rows.some((r) => r.strainId === s.id)
                    return (
                      <CommandItem
                        key={s.id}
                        value={s.id}
                        keywords={[s.name]}
                        disabled={alreadyDeclared}
                        onSelect={() => toggleStrain(s)}
                        className="min-h-14 gap-3 px-3 text-base"
                      >
                        <span
                          aria-hidden
                          className={cn(
                            'flex h-6 w-6 shrink-0 items-center justify-center rounded border-2',
                            ticked || alreadyDeclared ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
                          )}
                        >
                          {(ticked || alreadyDeclared) && <Check className="!size-4" />}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{s.name}</span>
                        {alreadyDeclared && (
                          <span className="shrink-0 text-xs text-muted-foreground">Already declared</span>
                        )}
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
            {count > 0 && (
              <div className="border-t p-2">
                <Button type="button" variant="outline" className="h-14 w-full" onClick={() => setPickerOpen(false)}>
                  Done choosing ({count} {plural(count, 'batch', 'batches')})
                </Button>
              </div>
            )}
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            className="h-14 w-full justify-between"
            aria-expanded={false}
            onClick={() => setPickerOpen(true)}
          >
            Add or remove strains
            <ChevronsUpDown className="h-4 w-4 opacity-60" />
          </Button>
        )}
      </section>

      {/* New batches */}
      {count > 0 && (
        <section aria-label="Batches to declare" className="space-y-2">
          <p className="text-sm font-medium text-muted-foreground">
            New {plural(count, 'batch', 'batches')} <span className="font-normal">({count})</span>
          </p>
          <ul className="space-y-2">
            {rows.map((r) => {
              const strain = strainById.get(r.strainId)
              const problem = problems.get(r.key)
              const isSplit = rows.findIndex((x) => x.strainId === r.strainId) !== rows.indexOf(r)
              return (
                <li
                  key={r.key}
                  className={cn('space-y-2 rounded-xl border-2 p-3', problem ? 'border-red-500/60' : 'border-border')}
                >
                  <div className="flex items-center gap-3">
                    <span className={cn('h-10 w-2 shrink-0 rounded-full', batchColor(r.strainId))} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-base font-semibold">{strain?.name ?? 'Unknown strain'}</p>
                      {isSplit && <p className="text-xs text-muted-foreground">Split batch</p>}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      aria-label={`Remove ${r.name || strain?.name || 'this batch'}`}
                      className="h-14 w-14 shrink-0"
                      onClick={() => removeRow(r.key)}
                    >
                      <X className="!size-5" />
                    </Button>
                  </div>
                  <Input
                    value={r.name}
                    onChange={(e) => renameRow(r.key, e.target.value)}
                    aria-label={`Batch name for ${strain?.name ?? 'strain'}`}
                    aria-invalid={problem !== undefined}
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    enterKeyHint="done"
                    className="h-14 font-mono text-base"
                  />
                  {problem && (
                    <div role="alert" className="space-y-2">
                      <p className="flex items-start gap-2 text-sm font-medium text-red-700 dark:text-red-300">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        {problem.message}
                      </p>
                      {problem.suggestion && (
                        <Button
                          type="button"
                          variant="outline"
                          className="h-14 w-full font-mono"
                          onClick={() => renameRow(r.key, problem.suggestion ?? r.name)}
                        >
                          Use {problem.suggestion}
                        </Button>
                      )}
                    </div>
                  )}
                  <Button type="button" variant="outline" className="h-14" onClick={() => splitRow(r)}>
                    <Plus className="mr-2 h-4 w-4" />
                    Split
                  </Button>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {count === 0 && declared.length === 0 && (
        <p className="text-sm text-muted-foreground">Pick at least one strain to declare a batch for it.</p>
      )}

      {submitError && (
        <p
          role="alert"
          className="rounded-md border border-red-500/50 bg-red-500/10 p-3 text-sm font-medium text-red-700 dark:text-red-300"
        >
          {submitError} Nothing was declared; you can try again.
        </p>
      )}

      <div className="space-y-2">
        <Button
          type="button"
          className="h-16 w-full text-lg font-bold"
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {submitting ? 'Declaring...' : `Declare ${count} ${plural(count, 'batch', 'batches')}`}
        </Button>
        <Button type="button" variant="ghost" className="h-14 w-full" disabled={submitting} onClick={skip}>
          {skipText}
        </Button>
      </div>
    </div>
  )
}

/**
 * What the cultivation dialogs say once the declare step is over. A skip is never an error: the
 * stage advance goes ahead and the batches can be declared from Harvest & Trim at any point before
 * the first wet weight.
 */
export function BatchStepOutcomeNote({ outcome }: { outcome: BatchStepOutcome | null }) {
  if (!outcome) return null
  if (outcome.kind === 'skipped') {
    return (
      <p
        role="status"
        className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm font-medium text-amber-700 dark:text-amber-300"
      >
        No batches declared yet. Declare them in{' '}
        <Link href={HUB} className="underline">
          Harvest &amp; Trim
        </Link>{' '}
        before the first wet weight is recorded.
      </p>
    )
  }
  const text =
    outcome.kind === 'declared'
      ? `${outcome.names.length} ${plural(outcome.names.length, 'batch', 'batches')} declared: ${outcome.names.join(', ')}`
      : `${outcome.count} ${plural(outcome.count, 'batch is', 'batches are')} already declared for this cycle`
  return (
    <p
      role="status"
      className="flex items-start gap-2 rounded-md border border-green-500/40 bg-green-500/10 p-3 text-sm font-medium text-green-700 dark:text-green-300"
    >
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
      {text}
    </p>
  )
}
