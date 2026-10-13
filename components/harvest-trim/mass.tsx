import { cn } from '@/lib/utils'
import { gramsText, lbText } from './format'

interface MassProps {
  g: number | null | undefined
  className?: string
  /** Stack grams under pounds (cards) instead of inline. */
  stacked?: boolean
}

/** Pounds first, grams alongside, so any figure can be checked against either scale. */
export function Mass({ g, className, stacked = false }: MassProps) {
  if (g === null || g === undefined) return <span className={cn('text-muted-foreground', className)}>{'—'}</span>
  return stacked ? (
    <span className={cn('inline-flex flex-col leading-tight', className)}>
      <span className="font-semibold">{lbText(g)}</span>
      <span className="text-xs text-muted-foreground">{gramsText(g)}</span>
    </span>
  ) : (
    <span className={className}>
      <span className="font-semibold">{lbText(g)}</span>{' '}
      <span className="text-xs text-muted-foreground">({gramsText(g)})</span>
    </span>
  )
}
