'use client'

import { useRef, useState } from 'react'
import { CheckCircle2, CircleSlash, FileUp, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { createHangers, importHangers, type HangerImportReport } from '@/actions/hangers'
import { useTrimRun } from './use-trim-run'

/** About 2000 rows of tag IDs is ~30 KB; anything near 1 MB is the wrong file. */
const MAX_FILE_BYTES = 1_000_000
const CHIP_LIMIT = 48

const EXAMPLE = `hanger_id,label_seq
H1B-001,1
H1B-002,2
H1B-003,3`

function CodeChips({ codes, tone }: { codes: string[]; tone: 'green' | 'neutral' }) {
  const [all, setAll] = useState(false)
  const shown = all ? codes : codes.slice(0, CHIP_LIMIT)
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {shown.map((c) => (
          <span
            key={c}
            className={cn(
              'rounded-md border px-2 py-1 font-mono text-sm',
              tone === 'green'
                ? 'border-green-500/40 bg-green-500/10'
                : 'border-border bg-muted/60 text-muted-foreground'
            )}
          >
            {c}
          </span>
        ))}
      </div>
      {codes.length > CHIP_LIMIT && (
        <Button type="button" variant="ghost" className="h-12" onClick={() => setAll((a) => !a)}>
          {all ? 'Show fewer' : `Show all ${codes.length}`}
        </Button>
      )}
    </div>
  )
}

interface GroupsProps {
  report: HangerImportReport
  /** Words for the first group: "Will be added" before, "Added" after. */
  addedLabel: string
  addedCodes: string[]
}

/**
 * Three outcomes, three different looks, on purpose. "Already registered" is
 * the normal result of re-importing a list and must never read like an error;
 * "Rejected" is the only group that needs a person to do something.
 */
function ImportGroups({ report, addedLabel, addedCodes }: GroupsProps) {
  const skipped = report.skipped
  return (
    <div className="space-y-3">
      <section className="rounded-lg border-2 border-green-500/50 bg-green-500/5 p-4">
        <div className="mb-2 flex items-center gap-2">
          <CheckCircle2 className="h-6 w-6 text-green-600" />
          <h3 className="text-lg font-semibold">
            {addedLabel}: {addedCodes.length}
          </h3>
        </div>
        {addedCodes.length > 0 ? (
          <CodeChips codes={addedCodes} tone="green" />
        ) : (
          <p className="text-muted-foreground">No new tags in this list.</p>
        )}
      </section>

      <section className="rounded-lg border-2 border-border bg-muted/30 p-4">
        <div className="mb-2 flex items-center gap-2">
          <CircleSlash className="h-6 w-6 text-muted-foreground" />
          <h3 className="text-lg font-semibold">Already registered, skipped: {skipped}</h3>
        </div>
        <p className="mb-2 text-sm text-muted-foreground">
          This is normal. Importing the same tags again changes nothing.
        </p>
        {report.skippedCodes.length > 0 && <CodeChips codes={report.skippedCodes} tone="neutral" />}
      </section>

      <section
        className={cn(
          'rounded-lg border-2 p-4',
          report.rejected.length > 0 ? 'border-red-500/60 bg-red-500/5' : 'border-border bg-muted/30'
        )}
      >
        <div className="mb-2 flex items-center gap-2">
          <TriangleAlert className={cn('h-6 w-6', report.rejected.length > 0 ? 'text-red-600' : 'text-muted-foreground')} />
          <h3 className="text-lg font-semibold">Rejected: {report.rejected.length}</h3>
        </div>
        {report.rejected.length === 0 ? (
          <p className="text-muted-foreground">Every row was readable.</p>
        ) : (
          <>
            <p className="mb-2 text-sm text-muted-foreground">
              These rows were not added. Fix them in the list and preview again, or leave them out.
            </p>
            <ul className="max-h-72 space-y-1.5 overflow-y-auto">
              {report.rejected.map((r, i) => (
                <li key={`${r.line}-${i}`} className="rounded-md border border-red-500/30 bg-background p-2 text-sm">
                  <span className="font-semibold">Line {r.line}</span>{' '}
                  <span className="font-mono text-muted-foreground">{r.raw || '(blank)'}</span>
                  <br />
                  {r.message}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {report.headerSkipped && <p className="text-sm text-muted-foreground">The first row looked like a header and was skipped.</p>}
      {report.truncated && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm font-medium text-amber-700 dark:text-amber-300">
          The list was longer than the importer reads in one go. Rows past the limit were ignored. Import the rest as a
          second list.
        </p>
      )}
      {report.nonStandardPrefixes.length > 0 && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm font-medium text-amber-700 dark:text-amber-300">
          The scanner only recognises H1B- tags today. Tags starting with {report.nonStandardPrefixes.join(', ')} will be
          registered but will not scan until the scanner is updated.
        </p>
      )}
    </div>
  )
}

interface HangerImportProps {
  onImported: () => void
  onViewRegistry: () => void
}

export function HangerImport({ onImported, onViewRegistry }: HangerImportProps) {
  const run = useTrimRun()
  const fileRef = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const [preview, setPreview] = useState<HangerImportReport | null>(null)
  const [result, setResult] = useState<HangerImportReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [count, setCount] = useState('')

  function edit(next: string) {
    setText(next)
    // Any edit makes the preview stale; the confirm re-reads the text on the server anyway.
    setPreview(null)
    setResult(null)
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (file.size > MAX_FILE_BYTES) {
      toast.error('That file is too large to be a list of hanger IDs.')
      return
    }
    try {
      const content = await file.text()
      setFileName(file.name)
      edit(content)
    } catch {
      toast.error('Could not read that file.')
    }
  }

  async function doPreview() {
    setBusy(true)
    setResult(null)
    const res = await run(importHangers({ text }))
    setBusy(false)
    if (res.success) setPreview(res.data)
  }

  async function doConfirm() {
    setBusy(true)
    const res = await run(importHangers({ text, confirm: true }))
    setBusy(false)
    if (!res.success) return
    setResult(res.data)
    setPreview(null)
    onImported()
    const n = res.data.inserted ?? 0
    toast.success(n > 0 ? `Added ${n} ${n === 1 ? 'hanger' : 'hangers'}` : 'Nothing new to add')
  }

  function reset() {
    setText('')
    setFileName(null)
    setPreview(null)
    setResult(null)
  }

  async function doGenerate() {
    const n = Number(count)
    if (!Number.isInteger(n) || n < 1) return
    setBusy(true)
    const res = await run(createHangers(n))
    setBusy(false)
    if (res.success) {
      toast.success(`Registered ${res.data.inserted} new IDs starting at ${res.data.codes[0] ?? res.data.start}`)
      setCount('')
      onImported()
    }
  }

  const newCount = preview?.newCodes.length ?? 0

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-4 pt-5">
          <div>
            <h2 className="text-lg font-semibold">Import hanger IDs</h2>
            <p className="text-muted-foreground">
              Load the IDs you printed. Paste a list (one per line) or upload the CSV your label tool exports. Safe to run
              again: tags that are already registered are skipped.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="import-text">
              Paste a list
            </Label>
            <Textarea
              id="import-text"
              value={text}
              onChange={(e) => edit(e.target.value)}
              rows={7}
              placeholder={EXAMPLE}
              spellCheck={false}
              autoCapitalize="characters"
              className="font-mono"
              disabled={busy}
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              className="sr-only"
              onChange={onFile}
              aria-label="Upload a CSV or text file of hanger IDs"
            />
            <Button type="button" variant="outline" onClick={() => fileRef.current?.click()} disabled={busy}>
              <FileUp className="mr-2 h-4 w-4" />
              Upload a CSV
            </Button>
            {fileName && <span className="text-sm text-muted-foreground">Loaded {fileName}</span>}
          </div>

          <Button
            type="button"
            className="h-12 w-full text-base font-semibold"
            disabled={busy || text.trim() === ''}
            onClick={doPreview}
          >
            {busy && !preview ? 'Checking...' : 'Preview'}
          </Button>
        </CardContent>
      </Card>

      {preview && (
        <Card>
          <CardContent className="space-y-4 pt-5">
            <h2 className="text-lg font-semibold">Preview</h2>
            <p className="text-muted-foreground">
              {preview.rowCount} {preview.rowCount === 1 ? 'row' : 'rows'} read. Nothing has been saved yet.
            </p>
            <ImportGroups report={preview} addedLabel="Will be added" addedCodes={preview.newCodes} />
            {newCount > 0 ? (
              <Button type="button" className="h-12 w-full text-base font-semibold" disabled={busy} onClick={doConfirm}>
                {busy
                  ? 'Adding...'
                  : preview.rejected.length > 0
                    ? `Add ${newCount} and skip the rejected rows`
                    : `Add ${newCount} ${newCount === 1 ? 'hanger' : 'hangers'}`}
              </Button>
            ) : (
              <div className="rounded-lg border bg-muted/40 p-4">
                <p className="font-semibold">Nothing new to add.</p>
                <p className="text-sm text-muted-foreground">
                  {preview.rejected.length > 0
                    ? 'Every readable row is already registered. Fix the rejected rows if they should be added.'
                    : 'Every tag in this list is already registered. That is fine.'}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {result && (
        <Card className="border-green-500/50">
          <CardContent className="space-y-4 pt-5">
            <h2 className="text-lg font-semibold">Import finished</h2>
            <ImportGroups report={result} addedLabel="Added" addedCodes={result.insertedCodes ?? []} />
            <div className="grid gap-2 sm:grid-cols-2">
              <Button type="button" onClick={onViewRegistry}>
                View the registry
              </Button>
              <Button type="button" variant="outline" onClick={reset}>
                Import another list
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <details className="rounded-lg border bg-card">
        <summary className="flex min-h-12 cursor-pointer list-none items-center px-4 py-3 font-semibold [&::-webkit-details-marker]:hidden">
          Advanced: register the next sequential IDs
        </summary>
        <div className="space-y-3 border-t p-4">
          <p className="text-sm text-muted-foreground">
            Creates the next IDs after the highest registered H1B number, without a file. The printed tags are the source
            of truth, so only use this if you will print exactly those numbers. Importing your label tool&apos;s list is
            safer.
          </p>
          <div className="flex gap-2">
            <Input
              value={count}
              onChange={(e) => /^\d{0,3}$/.test(e.target.value) && setCount(e.target.value)}
              inputMode="numeric"
              placeholder="How many?"
              aria-label="How many IDs to register"
              className="h-12 text-lg"
            />
            <Button
              type="button"
              variant="outline"
              className="shrink-0"
              disabled={busy || count === '' || Number(count) < 1}
              onClick={doGenerate}
            >
              Register
            </Button>
          </div>
        </div>
      </details>
    </div>
  )
}
