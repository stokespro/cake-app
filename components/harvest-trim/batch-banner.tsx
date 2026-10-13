import { cn } from '@/lib/utils'
import type { ScanBatch } from '@/actions/hangers'
import { batchColor, dateOnlyText } from './format'

interface BatchBannerProps {
  batch: ScanBatch | null
  className?: string
  sticky?: boolean
}

/**
 * Full-width coloured strip naming the batch. Pulling a hanger for the wrong
 * batch is the likeliest gloved-hand mistake, so the colour is stable per batch
 * and the strain is the largest word on it.
 */
export function BatchBanner({ batch, className, sticky = false }: BatchBannerProps) {
  if (!batch) {
    return (
      <div className={cn('rounded-lg bg-zinc-600 px-4 py-3 text-white', className)}>
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
        'rounded-lg px-4 py-3 text-white shadow-sm',
        batchColor(batch.id),
        sticky && 'sticky top-0 z-20',
        className
      )}
    >
      <p className="text-xl font-bold leading-tight">{batch.strainName ?? 'Unknown strain'}</p>
      <p className="text-base font-medium opacity-95">{batch.name}</p>
      {where.length > 0 && <p className="mt-0.5 text-sm opacity-90">{where.join(' · ')}</p>}
    </div>
  )
}
