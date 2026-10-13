'use client'

import { History, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { ScanLoad, ScanResult } from '@/actions/hangers'
import { BatchBanner } from './batch-banner'
import { LOAD_STATUS_META, agoText, plantsText } from './format'
import { Mass } from './mass'

interface LoadCardProps {
  scan: ScanResult
  load: ScanLoad
  canVoid: boolean
  onHistory: () => void
  onVoid: () => void
}

/**
 * The top of every station flow: which batch, which tag, what state, what
 * weights. The batch strip is sticky so it stays visible while weighing.
 */
export function LoadCard({ scan, load, canVoid, onHistory, onVoid }: LoadCardProps) {
  const meta = LOAD_STATUS_META[load.status]
  return (
    <div className="space-y-3">
      <BatchBanner batch={load.batch ?? scan.batch} sticky />
      <div className="rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center gap-3">
          <p className="font-mono text-4xl font-bold tracking-tight">{scan.hanger.code}</p>
          <span className={cn('rounded-full border px-3 py-1 text-sm font-semibold', meta.pill)}>{meta.label}</span>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Plants</dt>
            <dd className="font-semibold">{plantsText(load.plantCount)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Wet</dt>
            <dd><Mass g={load.wetG} stacked /></dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Dry</dt>
            <dd><Mass g={load.dryG} stacked /></dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Age</dt>
            <dd className="font-semibold">{agoText(load.createdAt)}</dd>
          </div>
        </dl>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={onHistory}>
            <History className="mr-2 h-4 w-4" />
            Full history
          </Button>
          {canVoid && (
            <details className="group">
              <summary className="flex min-h-12 cursor-pointer list-none items-center rounded-md border px-4 text-sm font-medium [&::-webkit-details-marker]:hidden">
                More
              </summary>
              <div className="pt-2">
                <Button type="button" variant="destructive" onClick={onVoid}>
                  <Trash2 className="mr-2 h-4 w-4" />
                  Void this load
                </Button>
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  )
}
