'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { ArrowLeft, Check, ChevronsUpDown, Loader2, MapPin, X } from 'lucide-react'
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  BUCKET_COLOR,
  BUCKET_LABEL,
  normalizeCity,
  type BucketFilter,
  type CityFocus,
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

/**
 * City values are stored uppercase, which reads as shouting in a dropdown of
 * 300 entries. Display only — the stored value stays the key for matching.
 */
function titleCase(city: string): string {
  return city
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

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
  const [cityFocus, setCityFocus] = useState<CityFocus | null>(null)
  const [cityPickerOpen, setCityPickerOpen] = useState(false)

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

  /**
   * The picker offers the cities actually present on the map, derived from the
   * loaded points rather than fetched separately — that way it can never offer
   * a city with nothing to fly to, and the count beside each entry is honest.
   *
   * Counts ignore the bucket and status filters on purpose: the picker moves
   * the camera, it does not filter, so "Tulsa 96" should mean 96 dispensaries
   * in Tulsa regardless of which layers happen to be switched on.
   */
  const cities = useMemo(() => {
    const counts = new Map<string, number>()
    for (const p of points) {
      const key = normalizeCity(p.city)
      if (!key) continue
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([city, count]) => ({ city, count }))
      .sort((a, b) => a.city.localeCompare(b.city))
  }, [points])

  const selectCity = (city: string) => {
    setCityPickerOpen(false)
    // Bump the nonce so re-picking the same city re-frames it.
    setCityFocus((prev) => ({ city, nonce: (prev?.nonce ?? 0) + 1 }))
  }

  /**
   * Clearing the city returns to the statewide framing. Uses the same nonce
   * channel as a selection so the map treats it as one more camera request
   * rather than needing a second mechanism.
   */
  const resetCity = () =>
    setCityFocus((prev) => (prev ? { city: '', nonce: prev.nonce + 1 } : null))

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
          <Popover open={cityPickerOpen} onOpenChange={setCityPickerOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                role="combobox"
                aria-expanded={cityPickerOpen}
                disabled={loading || cities.length === 0}
                className="h-8 w-[190px] justify-between text-xs font-normal"
              >
                <span className="truncate">
                  {/* Keyed off the city, not the object: clearing keeps a
                      {city: '', nonce} sentinel around so the map still gets a
                      camera request, and testing the object alone left the
                      trigger blank instead of returning to the placeholder. */}
                  {cityFocus?.city ? titleCase(cityFocus.city) : 'Go to city…'}
                </span>
                <ChevronsUpDown className="ml-1 h-3.5 w-3.5 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[240px] p-0" align="end">
              <Command>
                <CommandInput placeholder="Search city…" className="text-xs" />
                <CommandList>
                  <CommandEmpty>No city found.</CommandEmpty>
                  <CommandGroup>
                    {cities.map(({ city, count }) => (
                      <CommandItem
                        key={city}
                        value={city}
                        onSelect={() => selectCity(city)}
                        className="text-xs"
                      >
                        <Check
                          className={cn(
                            'mr-2 h-3.5 w-3.5',
                            cityFocus?.city === city ? 'opacity-100' : 'opacity-0'
                          )}
                        />
                        <span className="flex-1 truncate">{titleCase(city)}</span>
                        <span className="ml-2 tabular-nums text-muted-foreground">
                          {count}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>

          {cityFocus?.city && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={resetCity}
              aria-label="Clear city and show the whole state"
            >
              <X className="h-4 w-4" />
            </Button>
          )}

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
            cityFocus={cityFocus}
          />
        )}
      </div>
    </div>
  )
}
