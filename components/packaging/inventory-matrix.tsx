'use client'

import { cn } from '@/lib/utils'
import type { SKUStatus, InventoryCellState } from '@/lib/packaging/types'
import {
  FORMAT_COLUMNS,
  buildInventoryMatrix,
  getAttentionItems,
  type FormatColumn,
  type MatrixCell,
  type AttentionItem,
} from '@/lib/packaging/inventory-matrix'

// SPRO-128 — strain x format inventory matrix. Replaces the old flat,
// arbitrarily-ordered InventoryCard strip. Rows = strain (alphabetical,
// fixed). Columns = format (Eighth, Half, Bites, Variety — fixed order).
// Row/column position never changes on realtime refresh.
//
// STAGED is the dominant number in every cell (large, colored by state) —
// it's the one packaging acts on. FILLED/CASED drop to a small secondary
// line, each with its own color chip (blue/green, matching the app's
// existing FILLED/CASED color semantics) so they stay legible on a phone
// instead of collapsing into a washed-out grey line. Pending orders are a
// small corner pill so cell height never changes.
interface InventoryMatrixProps {
  skus: SKUStatus[]
  onCellClick: (sku: SKUStatus) => void
  variant: 'desktop' | 'mobile'
}

export function InventoryMatrix({ skus, onCellClick, variant }: InventoryMatrixProps) {
  if (skus.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">No inventory data</p>
  }

  const { strains, cells, otherSkus } = buildInventoryMatrix(skus)
  const attentionItems = getAttentionItems(skus)

  return (
    <div className="space-y-4">
      {attentionItems.length > 0 && (
        <div>
          <p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
            Needs Attention ({attentionItems.length})
          </p>
          <div className="flex flex-wrap gap-1.5">
            {attentionItems.map(item => (
              <AttentionChip key={item.sku.sku} item={item} onClick={() => onCellClick(item.sku)} />
            ))}
          </div>
        </div>
      )}

      {variant === 'desktop' ? (
        <DesktopMatrix strains={strains} cells={cells} onCellClick={onCellClick} />
      ) : (
        <MobileMatrix strains={strains} cells={cells} onCellClick={onCellClick} />
      )}

      {otherSkus.length > 0 && (
        <div>
          <p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
            Other
          </p>
          <div className={variant === 'desktop' ? 'flex flex-wrap gap-2' : 'grid grid-cols-2 gap-2'}>
            {otherSkus.map(sku => (
              <div key={sku.sku} className="w-[120px]">
                <p className="mb-1 truncate text-[10px] text-muted-foreground">
                  {sku.strainName || 'No strain'} · {sku.format || 'Unknown format'}
                </p>
                <MatrixCellView cell={{ kind: 'sku', sku }} onClick={onCellClick} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function DesktopMatrix({
  strains,
  cells,
  onCellClick,
}: {
  strains: string[]
  cells: Map<string, Map<FormatColumn, MatrixCell>>
  onCellClick: (sku: SKUStatus) => void
}) {
  if (strains.length === 0) return null

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] border-collapse text-sm">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-card px-2 py-1.5 text-left text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
              Strain
            </th>
            {FORMAT_COLUMNS.map(format => (
              <th
                key={format}
                className="px-1.5 py-1.5 text-center text-[10px] font-bold uppercase tracking-wide text-muted-foreground"
              >
                {format}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {strains.map(strain => (
            <tr key={strain} className="border-t border-border">
              <td className="sticky left-0 z-10 whitespace-nowrap bg-card px-2 py-1.5 text-sm font-semibold">
                {strain}
              </td>
              {FORMAT_COLUMNS.map(format => (
                <td key={format} className="px-1.5 py-1.5 align-top">
                  <MatrixCellView
                    cell={cells.get(strain)?.get(format) ?? { kind: 'na' }}
                    onClick={onCellClick}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function MobileMatrix({
  strains,
  cells,
  onCellClick,
}: {
  strains: string[]
  cells: Map<string, Map<FormatColumn, MatrixCell>>
  onCellClick: (sku: SKUStatus) => void
}) {
  if (strains.length === 0) return null

  return (
    <div className="space-y-2.5">
      {strains.map(strain => (
        <div key={strain} className="rounded-lg border border-border p-2.5">
          <p className="mb-1.5 text-sm font-semibold">{strain}</p>
          <div className="grid grid-cols-4 gap-1.5">
            {FORMAT_COLUMNS.map(format => (
              <div key={format}>
                <p className="mb-0.5 text-center text-[7px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {format}
                </p>
                <MatrixCellView
                  cell={cells.get(strain)?.get(format) ?? { kind: 'na' }}
                  onClick={onCellClick}
                />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// Colors/labels per cell state. `short`/`restage`/`low` share amber-ish
// urgency but restage/low differ in label; short is red (highest precedence).
const STATE_STYLES: Record<InventoryCellState, { border: string; bg: string; text: string }> = {
  short: { border: 'border-l-red-500', bg: 'bg-red-500/10', text: 'text-red-400' },
  restage: { border: 'border-l-amber-500', bg: 'bg-amber-500/10', text: 'text-amber-400' },
  low: { border: 'border-l-amber-500', bg: 'bg-amber-500/10', text: 'text-amber-400' },
  ok: { border: 'border-l-green-500', bg: 'bg-green-500/5', text: 'text-green-400' },
  idle: { border: 'border-l-border', bg: 'bg-muted/40', text: 'text-muted-foreground' },
}

function stateLabel(sku: SKUStatus): string | null {
  switch (sku.state) {
    case 'short':
      return `SHORT ${sku.gap}`
    case 'restage':
      return 'RESTAGE'
    case 'low':
      return 'LOW'
    default:
      return null
  }
}

function MatrixCellView({
  cell,
  onClick,
}: {
  cell: MatrixCell
  onClick: (sku: SKUStatus) => void
}) {
  if (cell.kind === 'na') {
    return (
      <div
        className="min-h-[60px] rounded-md border border-dashed border-border/70 opacity-40"
        style={{
          backgroundImage:
            'repeating-linear-gradient(135deg, var(--border) 0, var(--border) 3px, transparent 3px, transparent 9px)',
        }}
        aria-hidden="true"
      />
    )
  }

  if (cell.kind === 'inactive') {
    return (
      <div className="flex min-h-[60px] flex-col items-center justify-center gap-0.5 rounded-md border border-dashed border-border opacity-50">
        <span className="text-[8px] font-bold uppercase tracking-wide text-muted-foreground">
          INACTIVE
        </span>
      </div>
    )
  }

  const { sku } = cell
  const styles = STATE_STYLES[sku.state]
  const label = stateLabel(sku)

  return (
    <button
      type="button"
      onClick={() => onClick(sku)}
      className={cn(
        'relative flex min-h-[60px] w-full flex-col items-center justify-center gap-0.5 rounded-md border-l-[3px] px-1.5 pt-3 pb-1 text-left transition-colors hover:brightness-110',
        styles.border,
        styles.bg
      )}
    >
      <span className="absolute left-1.5 top-1 text-[8px] font-bold uppercase tracking-wide text-muted-foreground">
        {sku.sku}
      </span>
      {sku.pending > 0 && (
        <span className="absolute right-1 top-1 rounded-full border border-border bg-card px-1 text-[8px] font-bold text-muted-foreground">
          {sku.pending}
        </span>
      )}
      <span className={cn('text-lg font-extrabold leading-none', styles.text)}>{sku.staged}</span>
      {/* Amendment: order is FILLED then CASED, each with its own established
          color (blue = filled, green = cased) — not the washed-out uniform
          muted line from the original mockup. */}
      <span className="flex items-center gap-1 text-[9px]">
        <span className="font-semibold text-blue-400">{`F: ${sku.filled}`}</span>
        <span className="text-muted-foreground">-</span>
        <span className="font-semibold text-green-400">{`C: ${sku.cased}`}</span>
      </span>
      {label && (
        <span className={cn('text-[8px] font-extrabold uppercase tracking-wide', styles.text)}>
          {label}
        </span>
      )}
      {sku.state === 'idle' && <span className="text-[8px] text-muted-foreground">no demand</span>}
    </button>
  )
}

const ATTENTION_STYLES: Record<'short' | 'restage' | 'low', string> = {
  short: 'border-red-500/50 bg-red-500/10 text-red-400',
  restage: 'border-amber-500/50 bg-amber-500/10 text-amber-400',
  low: 'border-amber-500/40 bg-amber-500/5 text-amber-400',
}

function AttentionChip({ item, onClick }: { item: AttentionItem; onClick: () => void }) {
  const { sku } = item
  const text =
    sku.state === 'short'
      ? `${sku.sku} · SHORT ${sku.gap}`
      : sku.state === 'restage'
        ? `${sku.sku} · RESTAGE (${sku.pending} ord)`
        : `${sku.sku} · LOW (${sku.staged} staged)`

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors hover:brightness-110',
        ATTENTION_STYLES[sku.state as 'short' | 'restage' | 'low']
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {text}
    </button>
  )
}
