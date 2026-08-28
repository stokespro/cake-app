'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { ArrowLeft, Loader2, MapPin } from 'lucide-react'
import { useAuth } from '@/lib/auth-context'
import { getDispensaryMapPoints, type DispensaryMapPoint, type MapBucket } from '@/actions/customers'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorState } from '@/components/ui/error-state'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  BUCKET_COLOR,
  BUCKET_LABEL,
  type BucketFilter,
  type StatusFilter,
} from '@/components/dispensaries/dispensary-map'
import { cn } from '@/lib/utils'

/**
 * mapbox-gl touches `window` at module scope, so it cannot be evaluated during
 * the server render. Loading the map client-side only keeps this route from
 * breaking the build.
 */
const DispensaryMap = dynamic(
  () => import('@/components/dispensaries/dispensary-map').then((m) => m.DispensaryMap),
  {
    ssr: false,
    loading: () => <Skeleton className="h-full w-full rounded-lg" />,
  }
)

const ALL_BUCKETS: MapBucket[] = ['customer', 'claimed', 'unclaimed']

export default function DispensaryMapPage() {
  const { handleSessionError } = useAuth()

  const [points, setPoints] = useState<DispensaryMapPoint[]>([])
  const [ungeocoded, setUngeocoded] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [buckets, setBuckets] = useState<BucketFilter>({
    customer: true,
    claimed: true,
    unclaimed: true,
  })
  const [status, setStatus] = useState<StatusFilter>('active')
  const [visibleCount, setVisibleCount] = useState(0)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const result = await getDispensaryMapPoints()
    if (result.data) {
      setPoints(result.data)
      setUngeocoded(result.ungeocoded)
    } else {
      if (handleSessionError(result.error)) return
      setError("Couldn't load the dispensary map. Try again.")
      setPoints([])
    }
    setLoading(false)
  }, [handleSessionError])

  useEffect(() => {
    load()
  }, [load])

  /**
   * Counts are of the whole dataset, not the current filter — they are what the
   * toggles are offering to show, so they must not change as you toggle.
   */
  const totals = useMemo(() => {
    const counts: Record<MapBucket, number> = { customer: 0, claimed: 0, unclaimed: 0 }
    for (const p of points) {
      if (status === 'active' && !p.is_active) continue
      if (status === 'inactive' && p.is_active) continue
      counts[p.bucket]++
    }
    return counts
  }, [points, status])

  const toggleBucket = (bucket: MapBucket) =>
    setBuckets((prev) => ({ ...prev, [bucket]: !prev[bucket] }))

  if (error) {
    return (
      <div className="p-4">
        <ErrorState title="Unable to load map" message={error} onRetry={load} />
      </div>
    )
  }

  return (
    // Fixed viewport height rather than page flow: a map in a scrolling column
    // either collapses to nothing or fights the page scroll on touch.
    <div className="flex h-[calc(100vh-8rem)] flex-col gap-3 p-4 md:h-[calc(100vh-6rem)]">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="icon" className="h-8 w-8">
            <Link href="/dashboard/dispensaries" aria-label="Back to dispensaries">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold">
              <MapPin className="h-4 w-4" />
              Dispensary map
            </h1>
            <p className="text-xs text-muted-foreground">
              {loading
                ? 'Loading…'
                : `${visibleCount.toLocaleString()} of ${points.length.toLocaleString()} plotted`}
              {ungeocoded > 0 && !loading && (
                <>
                  {' · '}
                  <span title="These dispensaries have no coordinates and cannot be drawn. Re-run scripts/geocode-customers.mjs after fixing their addresses.">
                    {ungeocoded} without coordinates
                  </span>
                </>
              )}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
            <SelectTrigger className="h-8 w-[130px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
              <SelectItem value="all">All statuses</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Bucket toggles — the legend doubles as the filter */}
      <div className="flex flex-wrap gap-2">
        {ALL_BUCKETS.map((bucket) => {
          const on = buckets[bucket]
          return (
            <button
              key={bucket}
              type="button"
              onClick={() => toggleBucket(bucket)}
              aria-pressed={on}
              className={cn(
                'flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors',
                on
                  ? 'bg-background border-foreground/25'
                  : 'bg-muted/40 text-muted-foreground border-transparent'
              )}
            >
              <span
                className={cn(
                  'h-2.5 w-2.5 rounded-full transition-opacity',
                  on ? 'opacity-100' : 'opacity-30'
                )}
                style={{ backgroundColor: BUCKET_COLOR[bucket] }}
              />
              {BUCKET_LABEL[bucket]}
              <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-normal">
                {totals[bucket].toLocaleString()}
              </Badge>
            </button>
          )
        })}
      </div>

      {/* Map */}
      <div className="min-h-0 flex-1">
        {loading ? (
          <div className="flex h-full w-full items-center justify-center rounded-lg border">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <DispensaryMap
            points={points}
            buckets={buckets}
            status={status}
            onVisibleCountChange={setVisibleCount}
          />
        )}
      </div>
    </div>
  )
}
