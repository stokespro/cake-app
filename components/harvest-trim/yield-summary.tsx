import type { YieldMetric, YieldSummary } from '@/lib/trim/yield'
import { lbText, gramsText } from './format'

function weight(m: YieldMetric): string {
  return m.value === null ? '—' : `${lbText(m.value)} (${gramsText(m.value)})`
}

function pct(m: YieldMetric): string {
  return m.value === null ? '—' : `${m.value.toFixed(1)}%`
}

interface Row {
  label: string
  value: string
  metric?: YieldMetric
  note?: string
}

/**
 * Yield figures with their coverage. Each ratio only counts the hangers that
 * have both its numerator and denominator, and says so ("41 of 58 hangers"), so
 * a half-trimmed batch never reports a falsely low yield.
 */
export function YieldSummaryTable({ summary }: { summary: YieldSummary }) {
  const rows: Row[] = [
    { label: 'Plants', value: summary.plants.value === null ? '—' : String(summary.plants.value), metric: summary.plants },
    { label: 'Wet weight', value: weight(summary.wetG), metric: summary.wetG },
    { label: 'Dry weight', value: weight(summary.dryG), metric: summary.dryG },
    { label: 'Dry-down', value: pct(summary.dryDownPct), metric: summary.dryDownPct, note: 'dry as a share of wet' },
    { label: 'Worked so far', value: weight(summary.processedG), metric: summary.processedG, note: 'issued minus left on the hanger' },
    { label: 'Flower', value: weight(summary.flowerG), metric: summary.flowerG },
    { label: 'Trim', value: weight(summary.trimG), metric: summary.trimG },
    { label: 'Stems', value: weight(summary.stemsG), metric: summary.stemsG },
    { label: 'Flower share', value: pct(summary.flowerPctOfProcessed), metric: summary.flowerPctOfProcessed, note: 'of the weight worked' },
    { label: 'Trim share', value: pct(summary.trimPctOfProcessed), metric: summary.trimPctOfProcessed },
    { label: 'Stems share', value: pct(summary.stemsPctOfProcessed), metric: summary.stemsPctOfProcessed },
    { label: 'Unaccounted', value: pct(summary.unaccountedPctOfProcessed), metric: summary.unaccountedPctOfProcessed, note: 'positive means weight is missing' },
    { label: 'Wet to flower', value: pct(summary.wetToFlowerPct), metric: summary.wetToFlowerPct, note: 'finished hangers only' },
    {
      label: 'Flower per plant',
      value: summary.flowerPerPlantG.value === null ? '—' : `${summary.flowerPerPlantG.value.toFixed(1)} g`,
      metric: summary.flowerPerPlantG,
      note: 'finished hangers only',
    },
  ]
  const racks = summary.remainingOnRacks

  return (
    <div className="space-y-3">
      <dl className="divide-y rounded-lg border bg-card">
        {rows.map((r) => (
          <div key={r.label} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-4 py-3">
            <dt>
              <span className="font-medium">{r.label}</span>
              {r.note && <span className="block text-xs text-muted-foreground">{r.note}</span>}
            </dt>
            <dd className="text-right">
              <span className="text-lg font-semibold">{r.value}</span>
              {r.metric && r.metric.value !== null && (
                <span className="block text-xs text-muted-foreground">{r.metric.coverage.label}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      {racks.loads > 0 && (
        <p className="rounded-lg border border-violet-500/40 bg-violet-500/10 p-3 text-sm font-medium">
          Still on the racks: {racks.loads} unfinished {racks.loads === 1 ? 'hanger' : 'hangers'}, {lbText(racks.g)} and{' '}
          {racks.plants} {racks.plants === 1 ? 'plant' : 'plants'}.
        </p>
      )}
    </div>
  )
}
