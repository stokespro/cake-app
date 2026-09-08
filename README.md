# CAKE CRM (`cake-app`)

Cannabis wholesale CRM covering customers, orders, inventory, vault, packaging, and sales
operations. Next.js 16 (App Router) on Supabase, deployed to Vercel.

See [CLAUDE.md](CLAUDE.md) for architecture, auth model, and conventions.

## Local development

Requires Node.js 20.9+ (Next.js 16).

```bash
npm install
npm run dev     # http://localhost:3000 (Turbopack)
```

Create a `.env.local` in the repo root — it is gitignored, and there is no `.env.example`, so pull the values from the Supabase project dashboard:

```
NEXT_PUBLIC_SUPABASE_URL=<supabase project url>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service role key>
SESSION_SECRET=<openssl rand -hex 32>
```

All four are required:

- `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` — `lib/supabase/server.ts` throws without them.
- `SUPABASE_SERVICE_ROLE_KEY` — `createServiceClient()` throws without it, and nearly every server action uses that client.
- `SESSION_SECRET` — signs the `crm-session` cookie. Unset, PIN login fails closed and middleware redirects every authenticated route to `/login`.

Optional, only needed for the features that use them: `NEXT_PUBLIC_MAPBOX_TOKEN` (dispensary map), `OPENAI_API_KEY` (Slack agent), `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET` (Slack integration), `CRON_SECRET` (cron route auth).

### Checks

```bash
npm run lint          # ESLint 9
npm run type-check    # tsc --noEmit
npm test              # Vitest
npm run build         # server-export check + production build
```
