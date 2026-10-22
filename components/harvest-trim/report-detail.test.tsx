// Render-level coverage for the hanger table: the pay rule, subtotal semantics and the column choice. Static
// markup in the node environment (no DOM), which is enough to assert what is and is not in the table.

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TrimDayEpisode } from '@/actions/trim-reports'
import { defaultHiddenColumns } from '@/lib/trim/report-columns'
import type { SortState } from '@/lib/trim/report-table'
import { RENDER_STEP, ReportDetailView } from './report-detail'

let n = 0
function ep(over: Partial<TrimDayEpisode> = {}): TrimDayEpisode {
  n++
  return {
    checkoutId: `co-${n}`,
    seq: 1,
    hangerCode: `H1B-${String(n).padStart(3, '0')}`,
    loadId: `load-${n}`,
    batchId: 'b1',
    batchName: '1001-F1-BB',
    strainName: 'Bubble Bath',
    trimmerId: 't-antonio',
    trimmerName: 'Antonio',
    checkedOutAt: '2026-10-21T13:00:00+00:00',
    returnedAt: '2026-10-21T14:00:00+00:00',
    turnaroundHours: 1,
    issuedG: 600,
    flowerG: 250,
    trimG: 100,
    stemsG: 200,
    returnedTotalG: 550,
    varianceG: 5,
    variancePct: 0.8,
    varianceStatus: 'ok',
    returnKind: 'complete',
    ratePerLb: 225,
    payAmount: 50,
    ...over,
  }
}

const crew = [
  ep({ trimmerId: 't-antonio', trimmerName: 'Antonio' }),
  ep({ trimmerId: 't-antonio', trimmerName: 'Antonio' }),
  ep({ trimmerId: 't-wayne', trimmerName: 'Wayne' }),
]

const BY_TRIMMER: SortState = { key: 'trimmer', dir: 'asc' }

function render(over: Partial<React.ComponentProps<typeof ReportDetailView>> = {}) {
  return renderToStaticMarkup(
    <ReportDetailView
      episodes={crew}
      showMoney
      showDates={false}
      sort={BY_TRIMMER}
      onSortChange={() => {}}
      resetKey="k"
      hidden={defaultHiddenColumns()}
      onToggle={() => {}}
      onReset={() => {}}
      {...over}
    />
  )
}

/** Just the wide-screen table (the card list below it repeats the same figures). */
function table(html: string): string {
  return html.slice(html.indexOf('<table'), html.indexOf('</table>') + 8)
}

/** The <tr> elements of the table body that are subtotal rows. */
function subtotalRows(html: string): string[] {
  return [...table(html).matchAll(/<tr[^>]*data-subtotal[^>]*>[\s\S]*?<\/tr>/g)].map((m) => m[0])
}

/** Header cell labels of the table (the buttons inside <th>), in order. */
function headers(html: string): string[] {
  const head = html.slice(html.indexOf('<thead'), html.indexOf('</thead>'))
  return [...head.matchAll(/<button[^>]*>([^<]*)</g)].map((m) => m[1])
}

describe('columns', () => {
  it('default: nine columns, Trim and Stems off', () => {
    expect(headers(render())).toEqual(['Hanger', 'Batch', 'Trimmer', 'Out → in', 'Issued', 'Flower', 'Variance', 'Status', 'Pay'])
  })

  it('turning Trim and Stems on shows them', () => {
    expect(headers(render({ hidden: [] }))).toEqual([
      'Hanger', 'Batch', 'Trimmer', 'Out → in', 'Issued', 'Flower', 'Trim', 'Stems', 'Variance', 'Status', 'Pay',
    ])
  })

  it('Hanger stays even if a stored choice tried to hide it', () => {
    expect(headers(render({ hidden: ['hanger' as never, 'batch', 'trim', 'stems'] }))).toEqual(['Hanger', 'Trimmer', 'Out → in', 'Issued', 'Flower', 'Variance', 'Status', 'Pay'])
  })

  it('every shown header is a sort button with aria-sort', () => {
    const html = render({ sort: { key: 'flower', dir: 'desc' } })
    expect(html).toContain('aria-sort="descending"')
    expect(html.match(/aria-sort="none"/g)?.length).toBe(8)
  })
})

describe('pay rule: no Pay column for a viewer without pay access', () => {
  it('grow: not in the table, no dollar figure, no rate, not in the column selector', () => {
    const html = render({ showMoney: false, hidden: [] })
    expect(headers(html)).not.toContain('Pay')
    expect(table(html)).not.toMatch(/\$\d/)
    expect(html).not.toMatch(/\$\d/) // no dollar amount anywhere, table or cards
    expect(html).not.toContain('/lb')
    expect(html).not.toContain('>Pay<')
    // The selector is closed in static markup; it is built from selectableColumns(showMoney), covered in
    // lib/trim/report-columns.test.ts. Here: nothing in the page, open or not, offers Pay.
    expect(html).not.toMatch(/Pay/)
  })

  it('grow still gets subtotals, without a pay figure', () => {
    const html = render({ showMoney: false, hidden: [] })
    expect(html).toContain('data-subtotal')
    expect(html).not.toMatch(/\$\d/)
  })

  it('admin: Pay column, rate and subtotal pay are present', () => {
    const html = render()
    expect(headers(html)).toContain('Pay')
    expect(html).toContain('$225.00/lb')
    expect(html).toContain('$100.00') // Antonio's two $50 lines
  })
})

describe('subtotal rows', () => {
  it('sorted by trimmer: one per person, as a row with a row header, marked as a subtotal', () => {
    const rows = subtotalRows(render())
    expect(rows).toHaveLength(2)
    for (const r of rows) {
      expect(r).toContain('<th')
      expect(r).toContain('scope="row"')
      expect(r).toContain('Subtotal')
    }
    expect(rows[0]).toContain('2 hangers')
    expect(rows[0]).toContain('for Antonio') // announced with whose subtotal it is
    expect(rows[1]).toContain('1 hanger<')
  })

  it('any other sort: no subtotal rows', () => {
    const html = render({ sort: { key: 'flower', dir: 'desc' } })
    expect(html).not.toContain('data-subtotal')
    expect(html).not.toContain('Subtotal')
    expect(render({ sort: { key: 'outIn', dir: 'asc' } })).not.toContain('data-subtotal')
  })

  it('respects the visible columns: nothing for a hidden column, and the name moves into the label', () => {
    const [first] = subtotalRows(render({ hidden: ['trimmer', 'trim', 'stems', 'flower', 'pay'] }))
    expect(first).toContain('Antonio subtotal')
    expect(first).not.toContain('lb') // Flower is hidden, so no flower figure
    expect(first).not.toContain('$') // Pay is hidden
    expect(first).toContain('1,200 g') // Issued is visible
  })

  it('has one cell per visible column, so each figure sits under its header', () => {
    const [row] = subtotalRows(render())
    expect((row.match(/<t[dh][ >]/g) ?? []).length).toBe(9)
    const [fewer] = subtotalRows(render({ hidden: ['batch', 'status', 'pay', 'trim', 'stems'] }))
    expect((fewer.match(/<t[dh][ >]/g) ?? []).length).toBe(6)
  })
})

describe('totals vs rendered rows', () => {
  const big = Array.from({ length: RENDER_STEP + 40 }, (_, i) =>
    ep({ trimmerId: i < RENDER_STEP + 30 ? 't-a' : 't-b', trimmerName: i < RENDER_STEP + 30 ? 'Ana' : 'Bo', flowerG: 10, payAmount: 1 })
  )

  it('renders only a slice, says so, and the subtotal still covers the whole block', () => {
    const html = render({ episodes: big })
    expect(html).toContain(`Showing ${RENDER_STEP + 30} of ${RENDER_STEP + 40} hangers`) // block-aligned cut
    expect(html).toContain('Show all')
    // Ana's block is RENDER_STEP + 30 rows: her subtotal says so, though the slice could have ended earlier.
    expect(html).toContain(`${RENDER_STEP + 30} hangers`)
    expect(html).toContain('Totals and subtotals cover all')
  })

  it('a short list has no "show more"', () => {
    expect(render()).not.toContain('Show all')
  })
})
