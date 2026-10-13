'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { SearchX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { lookupHanger, type HangerLookup, type ScanSource } from '@/actions/hangers'
import { HangerDetailPanel } from './hanger-detail-panel'
import { ScanInput } from './scan-input'
import { useRefetchOnFocus } from './use-refetch-on-focus'
import { useTrimAccess } from './use-trim-access'
import { useTrimRun } from './use-trim-run'

const BASE = '/dashboard/harvest-trim'

type State =
  | { kind: 'idle' }
  | { kind: 'loading'; code: string }
  | { kind: 'found'; lookup: HangerLookup }
  | { kind: 'error'; code: string; message: string; notFound: boolean }

/**
 * "At any time we should be able to scan or enter a barcode id and see its
 * status" (R2.9b). Read-only and never a dead end: a tag in any state, even one
 * that was never used or isn't registered, gets a full answer and a next step.
 */
export function LookupClient() {
  const access = useTrimAccess()
  const run = useTrimRun()
  const [state, setState] = useState<State>({ kind: 'idle' })
  const codeRef = useRef<string | null>(null)

  const lookup = useCallback(
    async (code: string, source: ScanSource) => {
      codeRef.current = code
      setState({ kind: 'loading', code })
      const res = await run(lookupHanger(code, source), { quiet: true })
      if (res.success) {
        codeRef.current = res.data.hanger.code
        setState({ kind: 'found', lookup: res.data })
      } else {
        setState({ kind: 'error', code, message: res.error, notFound: res.code === 'NOT_FOUND' })
      }
    },
    [run]
  )

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('code')
    if (code) void lookup(code, 'typed')
  }, [lookup])

  useRefetchOnFocus(() => {
    if (codeRef.current) void lookup(codeRef.current, 'typed')
  })

  return (
    <div className="space-y-4">
      <ScanInput
        onScan={(code, source) => void lookup(code, source)}
        busy={state.kind === 'loading'}
        label="Scan or type any tag"
        helper="Shows the tag's status, who has it, its weights and its full history. Nothing here changes anything."
        buttonLabel="Look up"
      />

      {state.kind === 'idle' && (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            Scan a hanger tag, or type its number, to see where it stands.
          </CardContent>
        </Card>
      )}

      {state.kind === 'loading' && (
        <Card>
          <CardContent className="py-8 text-center text-base text-muted-foreground">Looking up {state.code}...</CardContent>
        </Card>
      )}

      {state.kind === 'error' && (
        <Card className="border-destructive/40">
          <CardContent className="space-y-3 py-8 text-center">
            <SearchX className="mx-auto h-10 w-10 text-destructive" />
            <p className="text-base font-semibold">{state.message}</p>
            {state.notFound ? (
              <>
                <p className="mx-auto max-w-md text-muted-foreground">
                  The tag format is fine, but it has not been added to the hanger registry. If it is a new printed tag,
                  import it.
                </p>
                {access.canOperate && (
                  <Button asChild>
                    <Link href={`${BASE}/hangers`}>Import hanger IDs</Link>
                  </Button>
                )}
              </>
            ) : (
              <Button
                type="button"
                variant="outline"
               
                onClick={() => void lookup(state.code, 'typed')}
              >
                Try again
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {state.kind === 'found' && (
        <HangerDetailPanel lookup={state.lookup} onChanged={() => void lookup(state.lookup.hanger.code, 'typed')} />
      )}
    </div>
  )
}
