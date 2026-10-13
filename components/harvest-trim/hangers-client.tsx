'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, Search } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { listHangers, setHangerStatus, type HangerRow } from '@/actions/hangers'
import type { HangerStatus } from '@/types/harvest-trim'
import { ErrorState } from '@/components/ui/error-state'
import { HANGER_STATUS_META, LOAD_STATUS_META } from './format'
import { HangerDetailSheet } from './hanger-detail-panel'
import { HangerImport } from './hanger-import'
import { ReasonDialog } from './reason-dialog'
import { useRefetchOnFocus } from './use-refetch-on-focus'
import { useTrimAccess } from './use-trim-access'
import { useTrimRun } from './use-trim-run'

const PAGE = 60
type Filter = 'all' | HangerStatus

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'retired', label: 'Retired' },
  { key: 'lost', label: 'Lost' },
]

interface StatusChange {
  hanger: HangerRow
  to: HangerStatus
}

export function HangersClient() {
  const access = useTrimAccess()
  const [tab, setTab] = useState<'registry' | 'import'>('registry')
  const [registryVersion, setRegistryVersion] = useState(0)

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="space-y-4">
      <TabsList className="grid h-auto w-full grid-cols-2 gap-1 p-1">
        <TabsTrigger value="registry">
          Registry
        </TabsTrigger>
        {access.canOperate && (
          <TabsTrigger value="import">
            Import IDs
          </TabsTrigger>
        )}
      </TabsList>
      <TabsContent value="registry" className="mt-0">
        <Registry version={registryVersion} />
      </TabsContent>
      {access.canOperate && (
        <TabsContent value="import" className="mt-0">
          <HangerImport
            onImported={() => {
              setRegistryVersion((v) => v + 1)
            }}
            onViewRegistry={() => setTab('registry')}
          />
        </TabsContent>
      )}
    </Tabs>
  )
}

function Registry({ version }: { version: number }) {
  const access = useTrimAccess()
  const run = useTrimRun()
  const [rows, setRows] = useState<HangerRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [shown, setShown] = useState(PAGE)
  const [detailCode, setDetailCode] = useState<string | null>(null)
  const [change, setChange] = useState<StatusChange | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(
    async (q: string, manual = false) => {
      if (manual) setRefreshing(true)
      const res = await run(listHangers(q ? { search: q } : {}), { quiet: true })
      if (res.success) {
        setRows(res.data)
        setError(null)
      } else {
        setError(res.error)
      }
      setRefreshing(false)
    },
    [run]
  )

  useEffect(() => {
    const t = setTimeout(() => void load(search.trim()), search ? 250 : 0)
    return () => clearTimeout(t)
  }, [search, load, version])

  useRefetchOnFocus(() => void load(search.trim()))

  const counts = useMemo(() => {
    const c = { all: 0, active: 0, retired: 0, lost: 0 }
    for (const r of rows ?? []) {
      c.all++
      c[r.status]++
    }
    return c
  }, [rows])

  const visible = useMemo(
    () => (rows ?? []).filter((r) => filter === 'all' || r.status === filter),
    [rows, filter]
  )

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setShown(PAGE)
          }}
          placeholder="Search tags, e.g. 042"
          aria-label="Search hangers"
          autoComplete="off"
          className="pl-10"
        />
      </div>

      <div className="flex items-center gap-2">
        <div className="-mx-4 flex flex-1 gap-2 overflow-x-auto px-4 md:mx-0 md:px-0" role="group" aria-label="Filter by status">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={filter === f.key}
              onClick={() => {
                setFilter(f.key)
                setShown(PAGE)
              }}
              className={cn(
                'h-12 shrink-0 rounded-lg border-2 px-4 text-sm font-semibold transition-colors',
                filter === f.key ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background hover:bg-muted'
              )}
            >
              {f.label} <span className="opacity-80">{counts[f.key]}</span>
            </button>
          ))}
        </div>
        <Button
          type="button"
          variant="outline"
          className="h-10 w-10 shrink-0"
          aria-label="Refresh"
          disabled={refreshing}
          onClick={() => void load(search.trim(), true)}
        >
          <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
        </Button>
      </div>

      {error && !rows && <ErrorState title="Could not load hangers" message={error} onRetry={() => void load(search.trim(), true)} />}
      {!rows && !error && <p className="py-8 text-center text-muted-foreground">Loading hangers...</p>}

      {rows && rows.length === 0 && (
        <Card>
          <CardContent className="space-y-1 py-8 text-center">
            <p className="font-semibold">{search ? 'No tag matches that search.' : 'No hangers are registered yet.'}</p>
            {!search && access.canOperate && (
              <p className="text-muted-foreground">Open the Import IDs tab to add the tags you printed.</p>
            )}
          </CardContent>
        </Card>
      )}

      {rows && rows.length > 0 && (
        <ul className="space-y-2">
          {visible.slice(0, shown).map((h) => {
            const meta = HANGER_STATUS_META[h.status]
            const latest = h.latestLoad
            return (
              <li key={h.id} className="rounded-lg border bg-card">
                <button
                  type="button"
                  onClick={() => setDetailCode(h.code)}
                  className="flex min-h-12 w-full items-center justify-between gap-3 p-3 text-left"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-base font-bold">{h.code}</span>
                      <span className={cn('rounded-full border px-2.5 py-0.5 text-xs font-semibold', meta.pill)}>
                        {meta.label}
                      </span>
                    </div>
                    <p className="truncate text-sm text-muted-foreground">
                      {latest
                        ? `${h.hasOpenLoad ? 'Open' : 'Last'}: ${LOAD_STATUS_META[latest.status].label}${latest.batchName ? ` · ${latest.batchName}` : ''}`
                        : 'Never used'}
                    </p>
                  </div>
                </button>
                {access.canOperate && (
                  <div className="flex flex-wrap gap-2 border-t px-3 py-2">
                    {h.status === 'active' ? (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                         
                          disabled={h.hasOpenLoad}
                          onClick={() => setChange({ hanger: h, to: 'retired' })}
                        >
                          Retire
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                         
                          disabled={h.hasOpenLoad}
                          onClick={() => setChange({ hanger: h, to: 'lost' })}
                        >
                          Mark lost
                        </Button>
                        {h.hasOpenLoad && (
                          <span className="self-center text-sm text-muted-foreground">
                            Has an open load: finish or void it first.
                          </span>
                        )}
                      </>
                    ) : (
                      <Button type="button" variant="outline" onClick={() => setChange({ hanger: h, to: 'active' })}>
                        Put back in service
                      </Button>
                    )}
                  </div>
                )}
              </li>
            )
          })}
          {visible.length > shown && (
            <li>
              <Button type="button" variant="outline" className="w-full" onClick={() => setShown((n) => n + PAGE)}>
                Show more ({visible.length - shown} left)
              </Button>
            </li>
          )}
          {visible.length === 0 && (
            <li className="py-6 text-center text-muted-foreground">Nothing in this filter.</li>
          )}
        </ul>
      )}

      <HangerDetailSheet code={detailCode} onOpenChange={(o) => !o && setDetailCode(null)} />

      <ReasonDialog
        open={change !== null}
        onOpenChange={(o) => !o && setChange(null)}
        title={
          change?.to === 'retired'
            ? `Retire ${change.hanger.code}?`
            : change?.to === 'lost'
              ? `Mark ${change.hanger.code} lost?`
              : `Put ${change?.hanger.code} back in service?`
        }
        description={
          change?.to === 'active'
            ? 'It will be able to take new loads again.'
            : 'It will not be able to take new loads. You can put it back later.'
        }
        chips={
          change?.to === 'lost'
            ? ['Cannot find it', 'Left the building', 'Other']
            : change?.to === 'retired'
              ? ['Bent or broken', 'Tag unreadable', 'No longer needed', 'Other']
              : ['Found it', 'Repaired', 'Retired by mistake', 'Other']
        }
        confirmLabel={change?.to === 'active' ? 'Put back in service' : change?.to === 'lost' ? 'Mark lost' : 'Retire hanger'}
        destructive={change?.to === 'lost'}
        onConfirm={async (reason) => {
          if (!change) return false
          const res = await run(setHangerStatus(change.hanger.id, change.to, reason))
          if (res.success) {
            toast.success(`${change.hanger.code} updated`)
            void load(search.trim())
          }
          return res.success
        }}
      />
    </div>
  )
}
