'use client'

import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

export interface StationNotice {
  tone: 'success' | 'warning' | 'info'
  title: string
  lines?: string[]
  action?: { label: string; onClick: () => void }
}

const TONES = {
  success: { box: 'border-green-500 bg-green-500/10', icon: CheckCircle2, iconClass: 'text-green-600' },
  warning: { box: 'border-amber-500 bg-amber-500/10', icon: AlertTriangle, iconClass: 'text-amber-600' },
  info: { box: 'border-sky-500 bg-sky-500/10', icon: Info, iconClass: 'text-sky-600' },
} as const

/** What just happened, until the next scan. A big, readable confirmation, never a vanishing toast. */
export function StationNoticeCard({ notice, onDismiss }: { notice: StationNotice; onDismiss: () => void }) {
  const tone = TONES[notice.tone]
  const Icon = tone.icon
  return (
    <div role="status" aria-live="polite" className={cn('rounded-xl border-2 p-4', tone.box)}>
      <div className="flex items-start gap-3">
        <Icon className={cn('mt-0.5 h-7 w-7 shrink-0', tone.iconClass)} />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-lg font-bold">{notice.title}</p>
          {notice.lines?.map((l) => (
            <p key={l} className="text-base">
              {l}
            </p>
          ))}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md hover:bg-black/5"
        >
          <X className="h-5 w-5" />
        </button>
      </div>
      {notice.action && (
        <Button type="button" className="mt-3 h-16 w-full text-lg font-bold" onClick={notice.action.onClick}>
          {notice.action.label}
        </Button>
      )}
    </div>
  )
}
