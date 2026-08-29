'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Map, {
  Layer,
  MapRef,
  NavigationControl,
  Popup,
  Source,
  type MapMouseEvent,
} from 'react-map-gl/mapbox'
import mapboxgl, { type GeoJSONSource } from 'mapbox-gl'
import type { GeoJSON } from 'geojson'
import { useTheme } from 'next-themes'
import Link from 'next/link'
import { Building2, ExternalLink, MapPin, Phone } from 'lucide-react'
import type { DispensaryMapPoint, MapBucket } from '@/actions/customers'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import 'mapbox-gl/dist/mapbox-gl.css'

const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN

/**
 * Opening camera, used when nothing is plotted. With pins present the map fits
 * their extent instead — see `fitBounds` below.
 */
const INITIAL_VIEW = { longitude: -97.1, latitude: 35.5, zoom: 6.2 }

/**
 * Pen the camera to Oklahoma and its margins. Without it a user can pan into
 * empty ocean and be told there are no dispensaries, which reads as broken
 * rather than empty.
 *
 * Deliberately much wider than the data. A snug box fights the opening camera:
 * at zoom 6.2 the viewport spans roughly 19 degrees of longitude, so a bound
 * narrower than that cannot contain it and Mapbox clamps, silently dragging the
 * opening view off-centre.
 */
const MAX_BOUNDS: [[number, number], [number, number]] = [
  [-107, 29.5],
  [-87, 41.5],
]

/**
 * Pin colours. Hard-coded hex rather than the theme's CSS custom properties
 * because Mapbox paints to a WebGL canvas — it never resolves `var(--primary)`,
 * and a colour passed as one silently renders black. These are picked to stay
 * legible on both the light and dark base styles.
 */
const BUCKET_COLOR: Record<MapBucket, string> = {
  customer: '#16a34a', // green — buying
  claimed: '#f59e0b', // amber — a rep owns it, no orders yet
  unclaimed: '#64748b', // slate — open territory
}

const BUCKET_LABEL: Record<MapBucket, string> = {
  customer: 'Customer',
  claimed: 'Claimed',
  unclaimed: 'Unclaimed',
}

/**
 * Cap the label length before it reaches Mapbox.
 *
 * `text-max-width` wraps rather than truncates, so a name like
 * "GREEN MEDICAL PATIENTS LLC - EDMOND" becomes a four-line block that shoulders
 * its neighbours out of the collision pass. Cutting it here keeps every label to
 * a predictable footprint; the full name is in the popup.
 */
function truncateLabel(name: string): string {
  const clean = String(name ?? '').trim()
  return clean.length > 26 ? `${clean.slice(0, 25).trimEnd()}…` : clean
}

/**
 * Cities arrive in mixed case ("Bartlesville" and "BARTLESVILLE" are both in
 * the table) with stray whitespace. Normalising on the way in stops one town
 * appearing twice in the picker and stops a lookup missing its own rows.
 */
export function normalizeCity(city: string | null | undefined): string {
  return String(city ?? '').trim().toUpperCase()
}

export type BucketFilter = Record<MapBucket, boolean>
export type StatusFilter = 'all' | 'active' | 'inactive'

/**
 * A request to move the camera to a city.
 *
 * `nonce` exists so that picking the same city twice re-frames it. Without it
 * the prop is unchanged, the effect does not re-run, and the control silently
 * does nothing the second time — which reads as a broken dropdown.
 */
export type CityFocus = { city: string; nonce: number }

type Props = {
  points: DispensaryMapPoint[]
  buckets: BucketFilter
  status: StatusFilter
  /** Reports the filtered count back up so the toolbar can show it. */
  onVisibleCountChange?: (count: number) => void
  /** Set by the city picker; moves the camera without changing what is plotted. */
  cityFocus?: CityFocus | null
}

export function DispensaryMap({
  points,
  buckets,
  status,
  onVisibleCountChange,
  cityFocus,
}: Props) {
  const mapRef = useRef<MapRef>(null)
  const { resolvedTheme } = useTheme()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  /**
   * Mapbox GL is WebGL-only. Where WebGL is unavailable — an old device, a
   * driver on Chrome's blocklist, hardware acceleration switched off — the Map
   * constructor throws inside an effect and the user is left staring at an
   * empty box with no explanation. Checked up front so that case gets a
   * message instead of silence.
   *
   * Deferred to an effect rather than computed during render: the check probes
   * for a WebGL context, which does not exist during the server pass and would
   * otherwise make the first client render disagree with the server's.
   */
  const [webglSupported, setWebglSupported] = useState<boolean | null>(null)
  useEffect(() => {
    setWebglSupported(mapboxgl.supported())
  }, [])

  /**
   * Filtering happens here rather than in the server action so a toggle is
   * instant and the camera never moves. All points are already in memory.
   */
  const visible = useMemo(
    () =>
      points.filter((p) => {
        if (!buckets[p.bucket]) return false
        if (status === 'active') return p.is_active
        if (status === 'inactive') return !p.is_active
        return true
      }),
    [points, buckets, status]
  )

  useEffect(() => {
    onVisibleCountChange?.(visible.length)
  }, [visible.length, onVisibleCountChange])

  const selected = useMemo(
    () => visible.find((p) => p.id === selectedId) ?? null,
    [visible, selectedId]
  )

  /**
   * Drop the popup when its dispensary is filtered out. Without this, hiding
   * the Unclaimed layer leaves an orphaned popup floating over a pin that is no
   * longer drawn.
   */
  useEffect(() => {
    if (selectedId && !visible.some((p) => p.id === selectedId)) setSelectedId(null)
  }, [visible, selectedId])

  const data = useMemo<GeoJSON.FeatureCollection<GeoJSON.Point>>(
    () => ({
      type: 'FeatureCollection',
      features: visible.map((p) => ({
        type: 'Feature',
        id: p.id,
        geometry: { type: 'Point', coordinates: [p.longitude, p.latitude] },
        properties: {
          id: p.id,
          bucket: p.bucket,
          label: truncateLabel(p.name),
        },
      })),
    }),
    [visible]
  )

  /**
   * Frame the actual footprint rather than a fixed centre, so a filter down to
   * a handful of customers zooms to them instead of leaving them as specks on a
   * statewide view. maxZoom stops a single result from slamming to street level.
   *
   * Computed once from the full set, not from `visible`: re-fitting on every
   * filter toggle yanks the camera around and loses the user's place.
   */
  const fitBounds = useMemo(() => {
    if (!points.length) return null
    let minLng = Infinity
    let minLat = Infinity
    let maxLng = -Infinity
    let maxLat = -Infinity
    for (const p of points) {
      minLng = Math.min(minLng, p.longitude)
      maxLng = Math.max(maxLng, p.longitude)
      minLat = Math.min(minLat, p.latitude)
      maxLat = Math.max(maxLat, p.latitude)
    }
    const padLng = Math.max((maxLng - minLng) * 0.05, 0.05)
    const padLat = Math.max((maxLat - minLat) * 0.05, 0.05)
    return [
      [minLng - padLng, minLat - padLat],
      [maxLng + padLng, maxLat + padLat],
    ] as [[number, number], [number, number]]
  }, [points])

  /**
   * Fly to a city when the picker asks for one.
   *
   * Frames every dispensary in that city rather than a single centre point, so
   * a spread-out town like Oklahoma City arrives at a zoom that shows all of
   * it. Deliberately does NOT filter — the surrounding dispensaries stay
   * plotted, which is the point when you are working out who else is nearby.
   *
   * Matched against the whole `points` set, not `visible`: a city picked while
   * the Customer layer is off should still take you there rather than silently
   * doing nothing.
   */
  useEffect(() => {
    if (!cityFocus) return
    const map = mapRef.current?.getMap()
    if (!map) return

    // Empty city is the "clear" signal from the picker: go back to the whole
    // state rather than sitting wherever the last city left the camera.
    if (!normalizeCity(cityFocus.city)) {
      if (fitBounds) map.fitBounds(fitBounds, { padding: 24, maxZoom: 11, duration: 900 })
      return
    }

    const inCity = points.filter(
      (p) => normalizeCity(p.city) === normalizeCity(cityFocus.city)
    )
    if (!inCity.length) return

    let minLng = Infinity
    let minLat = Infinity
    let maxLng = -Infinity
    let maxLat = -Infinity
    for (const p of inCity) {
      minLng = Math.min(minLng, p.longitude)
      maxLng = Math.max(maxLng, p.longitude)
      minLat = Math.min(minLat, p.latitude)
      maxLat = Math.max(maxLat, p.latitude)
    }

    // A town with one dispensary, or several at one address, has zero extent.
    // fitBounds on a degenerate box zooms to maximum; the floor keeps the
    // arrival at street level with context around it.
    const padLng = Math.max((maxLng - minLng) * 0.15, 0.01)
    const padLat = Math.max((maxLat - minLat) * 0.15, 0.01)

    map.fitBounds(
      [
        [minLng - padLng, minLat - padLat],
        [maxLng + padLng, maxLat + padLat],
      ],
      { padding: 64, maxZoom: 14, duration: 900 }
    )
  }, [cityFocus, points, fitBounds])

  const onMapClick = useCallback((event: MapMouseEvent) => {
    const feature = event.features?.[0]
    if (!feature) {
      setSelectedId(null)
      return
    }
    const map = mapRef.current?.getMap()
    const [longitude, latitude] = (feature.geometry as GeoJSON.Point).coordinates

    // Tapping a cluster drills into it rather than selecting anything.
    if (feature.properties?.cluster) {
      const source = map?.getSource('dispensaries') as GeoJSONSource | undefined
      source?.getClusterExpansionZoom(
        feature.properties.cluster_id as number,
        (err, zoom) => {
          if (err || zoom == null) return
          map?.easeTo({ center: [longitude, latitude], zoom, duration: 500 })
        }
      )
      return
    }

    const id = feature.properties?.id as string | undefined
    setSelectedId(id ?? null)
  }, [])

  if (webglSupported === false) {
    return (
      <div className="flex h-full min-h-[420px] items-center justify-center rounded-lg border border-dashed bg-muted/30 p-8 text-center">
        <div className="max-w-md space-y-2">
          <MapPin className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="font-medium">This browser can&apos;t display the map</p>
          <p className="text-sm text-muted-foreground">
            The map needs WebGL, which this browser or device has turned off.
            Try a different browser, or enable hardware acceleration. The{' '}
            <Link href="/dashboard/dispensaries" className="underline">
              dispensary list
            </Link>{' '}
            has the same {points.length.toLocaleString()} records.
          </p>
        </div>
      </div>
    )
  }

  if (!TOKEN) {
    return (
      <div className="flex h-full min-h-[420px] items-center justify-center rounded-lg border border-dashed bg-muted/30 p-8 text-center">
        <div className="max-w-md space-y-2">
          <MapPin className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="font-medium">Map unavailable</p>
          <p className="text-sm text-muted-foreground">
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              NEXT_PUBLIC_MAPBOX_TOKEN
            </code>{' '}
            is not set. Add a Mapbox token to the environment and redeploy — the
            dispensary data is already loaded and {points.length} pins are ready
            to draw.
          </p>
        </div>
      </div>
    )
  }

  const mapStyle =
    resolvedTheme === 'dark'
      ? 'mapbox://styles/mapbox/dark-v11'
      : 'mapbox://styles/mapbox/light-v11'

  // Mapbox expression selecting a pin colour from the feature's bucket.
  const colorByBucket: [string, ...unknown[]] = [
    'match',
    ['get', 'bucket'],
    'customer',
    BUCKET_COLOR.customer,
    'claimed',
    BUCKET_COLOR.claimed,
    BUCKET_COLOR.unclaimed,
  ]

  return (
    <div className="relative h-full w-full overflow-hidden rounded-lg border">
      <Map
        ref={mapRef}
        mapboxAccessToken={TOKEN}
        initialViewState={
          fitBounds
            ? {
                bounds: fitBounds,
                // Tight padding because the phone layout is the constraint:
                // Oklahoma's extent is wide and short, the mobile map container
                // is tall and narrow, and fitBounds has to satisfy the width.
                // Generous padding there costs zoom on the axis that is already
                // scarce and pushes the state into a small band of the screen.
                fitBoundsOptions: { padding: 24, maxZoom: 11 },
              }
            : INITIAL_VIEW
        }
        maxBounds={MAX_BOUNDS}
        mapStyle={mapStyle}
        interactiveLayerIds={['clusters', 'unclustered']}
        onClick={onMapClick}
        onMouseEnter={(e) => {
          const c = e.target.getCanvas()
          if (c) c.style.cursor = 'pointer'
        }}
        onMouseLeave={(e) => {
          const c = e.target.getCanvas()
          if (c) c.style.cursor = ''
        }}
        style={{ width: '100%', height: '100%' }}
      >
        <NavigationControl position="top-right" showCompass={false} />

        <Source
          id="dispensaries"
          type="geojson"
          data={data}
          cluster
          // Cluster only down to zoom 11. Above that the pins separate on their
          // own and the colour coding — the whole point of the map — becomes
          // readable. A third of these sit in Tulsa and OKC and overlap badly
          // at statewide zoom, which is what clustering is for.
          clusterMaxZoom={11}
          clusterRadius={45}
        >
          <Layer
            id="clusters"
            type="circle"
            filter={['has', 'point_count']}
            paint={{
              // Clusters are deliberately neutral. Colouring them by majority
              // bucket would read as "these are all unclaimed" when a cluster
              // of 200 happens to contain the three customers you were looking
              // for.
              'circle-color': '#0ea5e9',
              'circle-opacity': 0.85,
              'circle-radius': ['step', ['get', 'point_count'], 16, 10, 22, 50, 30],
              'circle-stroke-width': 2,
              'circle-stroke-color': '#ffffff',
              'circle-stroke-opacity': 0.6,
            }}
          />
          <Layer
            id="cluster-count"
            type="symbol"
            filter={['has', 'point_count']}
            layout={{
              'text-field': ['get', 'point_count_abbreviated'],
              'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
              'text-size': 12,
            }}
            paint={{ 'text-color': '#ffffff' }}
          />
          <Layer
            id="unclustered"
            type="circle"
            filter={['!', ['has', 'point_count']]}
            paint={{
              'circle-color': colorByBucket,
              // The selected pin reads larger so the link between the popup and
              // its pin stays obvious while the user pans.
              'circle-radius': ['case', ['==', ['get', 'id'], selectedId ?? ''], 11, 7],
              'circle-stroke-width': 2,
              'circle-stroke-color': '#ffffff',
              'circle-stroke-opacity': [
                'case',
                ['==', ['get', 'id'], selectedId ?? ''],
                1,
                0.85,
              ],
            }}
          />
          <Layer
            id="pin-labels"
            type="symbol"
            // The dispensary name on the pin itself, so an un-clicked dot is
            // identifiable without opening its popup. This replaced a rep-
            // initials label; the rep still shows in the popup, which is the
            // only place it is unambiguous anyway.
            //
            // Below the cluster threshold there is nothing to label — the dots
            // are clusters — so this starts where clustering stops.
            filter={['!', ['has', 'point_count']]}
            minzoom={11}
            layout={{
              'text-field': ['get', 'label'],
              'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
              'text-size': 11,
              'text-offset': [0, -1.3],
              // Collision handling rather than allow-overlap: dispensary names
              // are long and these sit on top of each other in Tulsa and OKC.
              // Mapbox drops labels that would overlap, so what remains is
              // legible; allowing overlap turns a dense area into a smear.
              'text-allow-overlap': false,
              'text-optional': true,
              'text-max-width': 9,
            }}
            paint={{
              'text-color': resolvedTheme === 'dark' ? '#f8fafc' : '#0f172a',
              'text-halo-color': resolvedTheme === 'dark' ? '#000000' : '#ffffff',
              'text-halo-width': 1.5,
            }}
          />
        </Source>

        {selected && (
          <Popup
            longitude={selected.longitude}
            latitude={selected.latitude}
            // No fixed anchor. Pinning it to "bottom" means the popup always
            // opens upward, and a pin near the top of the map then has its
            // popup clipped by the container's overflow. Left unset, mapbox-gl
            // picks an anchor that fits the space available.
            offset={14}
            closeButton
            closeOnClick={false}
            onClose={() => setSelectedId(null)}
            maxWidth="320px"
            className="dispensary-map-popup"
          >
            <DispensaryPopupBody point={selected} />
          </Popup>
        )}
      </Map>
    </div>
  )
}

/**
 * Popup contents.
 *
 * Customer and Claimed pins name the assigned agent; Unclaimed pins show the
 * dispensary alone, because there is no agent to show and an "Unassigned" line
 * would just be noise on 1,700 of the pins.
 */
function DispensaryPopupBody({ point }: { point: DispensaryMapPoint }) {
  return (
    <div className="space-y-2 p-1 text-foreground">
      <div className="space-y-1">
        <div className="flex items-start gap-2">
          <Building2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-sm leading-snug font-semibold">{point.name}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 pl-6">
          <Badge
            variant="outline"
            className="gap-1.5 text-[11px]"
            style={{ borderColor: BUCKET_COLOR[point.bucket] }}
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: BUCKET_COLOR[point.bucket] }}
            />
            {BUCKET_LABEL[point.bucket]}
          </Badge>
          {!point.is_active && (
            <Badge variant="secondary" className="text-[11px]">
              Inactive
            </Badge>
          )}
        </div>
      </div>

      <dl className="space-y-1 pl-6 text-xs text-muted-foreground">
        {point.address && (
          <div className="flex items-start gap-1.5">
            <MapPin className="mt-0.5 h-3 w-3 shrink-0" />
            <span>{point.address}</span>
          </div>
        )}
        {point.phone && (
          <div className="flex items-center gap-1.5">
            <Phone className="h-3 w-3 shrink-0" />
            <a href={`tel:${point.phone}`} className="hover:underline">
              {point.phone}
            </a>
          </div>
        )}
        {point.omma_license && (
          <div className="pt-0.5">
            <span className="font-mono text-[11px]">{point.omma_license}</span>
          </div>
        )}
      </dl>

      {point.rep_name && (
        <div className="ml-6 flex items-center gap-2 rounded-md bg-muted/60 px-2 py-1.5">
          <span
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
            style={{ backgroundColor: BUCKET_COLOR[point.bucket] }}
          >
            {point.rep_initials}
          </span>
          <div className="min-w-0 leading-tight">
            <p className="truncate text-xs font-medium">{point.rep_name}</p>
            <p className="text-[11px] text-muted-foreground">
              {point.bucket === 'customer' ? 'Account rep' : 'Claimed by'}
            </p>
          </div>
        </div>
      )}

      {point.bucket === 'customer' && (
        <p className="pl-6 text-[11px] text-muted-foreground">
          {point.order_count ?? 0} {point.order_count === 1 ? 'order' : 'orders'}
          {point.last_order_date && ` · last ${point.last_order_date}`}
        </p>
      )}

      <div className="pl-6 pt-0.5">
        <Button asChild size="sm" variant="secondary" className="h-7 w-full text-xs">
          <Link href={`/dashboard/dispensaries/${point.id}`}>
            Open profile
            <ExternalLink className="ml-1 h-3 w-3" />
          </Link>
        </Button>
      </div>
    </div>
  )
}

export { BUCKET_COLOR, BUCKET_LABEL }
