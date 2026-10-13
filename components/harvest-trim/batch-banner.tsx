import { cn } from '@/lib/utils'
import type { ScanBatch } from '@/actions/hangers'
import { dateOnlyText } from './format'

interface BatchBannerProps {
  batch: ScanBatch | null
  className?: string
  sticky?: boolean
}

/**
 * Full-width strip naming the batch. Pulling a hanger for the wrong batch is
 * the likeliest gloved-hand mistake, so it carries a heavy border and the
 * strain is the largest word on it.
 */
export function BatchBanner({ batch, className, sticky = false }: BatchBannerProps) {
  if (!batch) {
    return (
      <div className={cn('rounded-lg border-2 bg-muted px-4 py-3 text-muted-foreground', className)}>
        <p className="text-sm font-medium">No batch</p>
      </div>
    )
  }
  const where = [
    batch.roomName ?? (batch.roomNumber !== null ? `Room ${batch.roomNumber}` : null),
    batch.cycleNumber !== null ? `Cycle ${batch.cycleNumber}` : null,
    batch.harvestDate ? `Harvested ${dateOnlyText(batch.harvestDate)}` : null,
  ].filter(Boolean)

  return (
    <div
      className={cn(
        'rounded-lg border-2 border-primary bg-card px-4 py-3 text-card-foreground shadow-sm',
        sticky && 'sticky top-0 z-20',
        className
      )}
    >
      <p className="text-lg font-bold leading-tight">{batch.strainName ?? 'Unknown strain'}</p>
      <p className="text-base font-medium">{batch.name}</p>
      {where.length > 0 && <p className="mt-0.5 text-sm text-muted-foreground">{where.join(' · ')}</p>}
    </div>
  )
}
