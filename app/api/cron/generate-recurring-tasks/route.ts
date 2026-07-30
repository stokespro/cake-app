// app/api/cron/generate-recurring-tasks/route.ts
//
// Nightly cultivation recurring-task generation cron.
//
// Vercel invokes this route on the schedule defined in vercel.json:
//   0 8 * * *   → ~3:00am Central (ahead of the morning work block)
//
// Moves recurring-task generation OFF the page-load path (previously run as
// an awaited call inside fetchData() on every cultivation page load) and
// onto a scheduled job. The underlying generation logic
// (generateRecurringTasksCore, in lib/cultivation/generate-recurring-tasks.ts)
// is already idempotent — it uses a last_generated_date watermark per
// recurring definition and filters candidate dates against existing children
// — so re-running this cron (or a stale manual trigger) is always safe.
//
// Auth: Vercel sends `Authorization: Bearer <CRON_SECRET>` automatically when
// CRON_SECRET is set in Vercel environment variables. Requests without the
// correct header are rejected 401.
//
// NOTE: CRON_SECRET must be added to Vercel environment variables before this
// cron can run in production. The route will always 401 until that secret is
// configured.
//
// generateRecurringTasksCore() is intentionally NOT exported from
// actions/cultivation.ts ('use server') — see that file's comment for why
// doing so would make it a public, unauthenticated, service-role write
// endpoint bypassing this route's CRON_SECRET check entirely.

import { type NextRequest, NextResponse } from 'next/server'
import { generateRecurringTasksCore } from '@/lib/cultivation/generate-recurring-tasks'

// Force Node.js runtime — generateRecurringTasksCore builds its Supabase
// client via createServiceClient() (lib/supabase/server.ts), which is
// session-independent but still lives in the Node.js server bundle.
export const runtime = 'nodejs'

// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest): Promise<NextResponse> {
  // --- Auth gate: Vercel cron Bearer token ---
  const authHeader = req.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { ok: false, error: 'Unauthorized' },
      { status: 401 }
    )
  }

  const result = await generateRecurringTasksCore()

  if ('error' in result) {
    console.error('[generate-recurring-tasks] error:', result.error)
    return NextResponse.json(
      { ok: false, error: result.error },
      { status: 500 }
    )
  }

  console.log(`[generate-recurring-tasks] Generated ${result.generated} task(s).`)

  return NextResponse.json({ ok: true, generated: result.generated })
}
