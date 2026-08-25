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
// SPRO-132 — CASED is the dominant number in every cell: it's finished,
// sellable inventory, and the Packaging Manager reads the board for "how
// much do we actually have." The big number is intentionally neutral
// (text-foreground) rather than state-colored — state now reads from the
// card itself (tinted background + full colored border, with a stronger
// left accent), so color communicates urgency at the card level instead of
// competing with the number for attention. STAGED/FILLED sit in a
// full-width bottom row (staged left, filled right) so both stay legible
// without shrinking to an unreadable line. Pending orders are a small
// corner pill so cell height stays fixed regardless of state.
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
                <MatrixCellView cell={{ kind: 'sku', sku }} onClick={onCellClick} variant="desktop" />
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
                    variant="desktop"
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
                  variant="mobile"
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
// `borderAll` tints all four sides of the card; `borderL` layers a heavier
// left accent on top of it (Tailwind resolves the more specific `border-l-*`
// utility over the general `border-*` color for the left edge, which is the
// standard pattern for accent-bordered cards).
const STATE_STYLES: Record<
  InventoryCellState,
  { borderAll: string; borderL: string; bg: string; text: string }
> = {
  short: { borderAll: 'border-red-500/40', borderL: 'border-l-red-500', bg: 'bg-red-500/10', text: 'text-red-400' },
  restage: {
    borderAll: 'border-amber-500/40',
    borderL: 'border-l-amber-500',
    bg: 'bg-amber-500/10',
    text: 'text-amber-400',
  },
  low: { borderAll: 'border-amber-500/40', borderL: 'border-l-amber-500', bg: 'bg-amber-500/10', text: 'text-amber-400' },
  ok: { borderAll: 'border-green-500/30', borderL: 'border-l-green-500', bg: 'bg-green-500/5', text: 'text-green-400' },
  idle: { borderAll: 'border-border', borderL: 'border-l-border', bg: 'bg-muted/40', text: 'text-muted-foreground' },
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
  variant,
}: {
  cell: MatrixCell
  onClick: (sku: SKUStatus) => void
  variant: 'desktop' | 'mobile'
}) {
  if (cell.kind === 'na') {
    return (
      <div
        className="min-h-[68px] rounded-md border border-dashed border-border/70 opacity-40"
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
      <div className="flex min-h-[68px] flex-col items-center justify-center gap-0.5 rounded-md border border-dashed border-border opacity-50">
        <span className="text-[8px] font-bold uppercase tracking-wide text-muted-foreground">
          INACTIVE
        </span>
      </div>
    )
  }

  const { sku } = cell
  const styles = STATE_STYLES[sku.state]
  const label = stateLabel(sku)
  const cornerTextSize = variant === 'desktop' ? 'text-[11px]' : 'text-[9px]'

  return (
    <button
      type="button"
      onClick={() => onClick(sku)}
      className={cn(
        'relative flex min-h-[68px] w-full flex-col items-center justify-between gap-1 rounded-md border border-l-[3px] px-1.5 pt-4 pb-1 text-left transition-colors hover:brightness-110',
        styles.borderAll,
        styles.borderL,
        styles.bg
      )}
    >
      {/* Bounded via left+right (not just a font-size guess) so the code can
          never run under the pending pill: reserve ~1.25rem on the right
          when the pill renders, truncate rather than wrap. */}
      <span
        className={cn(
          'absolute left-1.5 top-1 truncate font-bold uppercase tracking-wide text-muted-foreground',
          cornerTextSize,
          sku.pending > 0 ? 'right-5' : 'right-1'
        )}
      >
        {sku.sku}
      </span>
      {sku.pending > 0 && (
        <span
          className={cn(
            'absolute right-1 top-1 rounded-full border border-border bg-card px-1 font-bold text-muted-foreground',
            cornerTextSize
          )}
        >
          {sku.pending}
        </span>
      )}

      <span className="flex flex-1 flex-col items-center justify-center gap-0.5">
        <span className="text-lg font-extrabold leading-none text-foreground">{sku.cased}</span>
        {label && (
          <span className={cn('text-[8px] font-extrabold uppercase tracking-wide', styles.text)}>
            {label}
          </span>
        )}
        {sku.state === 'idle' && (
          <span className="text-[8px] text-muted-foreground">no demand</span>
        )}
      </span>

      {/* Full-width bottom row: staged (left) / filled (right). Staged stays
          neutral — state color already lives on the card border/bg — while
          filled keeps the app's established blue so it reads consistently
          with FILLED elsewhere on the board. */}
      <span className="flex w-full items-center justify-between text-[9px]">
        <span>
          <span className="text-muted-foreground">{variant === 'desktop' ? 'STAGED: ' : 'S: '}</span>
          <span className="font-semibold text-foreground">{sku.staged}</span>
        </span>
        <span>
          <span className="text-muted-foreground">{variant === 'desktop' ? 'FILLED: ' : 'F: '}</span>
          <span className="font-semibold text-blue-400">{sku.filled}</span>
        </span>
      </span>
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
