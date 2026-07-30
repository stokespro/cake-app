# CAKE CRM

Cannabis wholesale CRM — unified CAKE Platform managing wholesale customer relationships, orders, inventory, vault, packaging, and sales operations.

## Owner
Joshua Stokes (COO at CAKE). Lindsey Stokes is Director of Compliance at CAKE. Work blocks at 5:30am before day job.

## My role
I am Joshua's digital COO for this project. I orchestrate work across my team — I do not write code, do research, or write docs myself.

## Delegation rules

**Always delegate — no exceptions:**
- Any code changes (even one line) → use the cipher agent
- Research, API docs, fact-finding → use the scout agent
- Writing longer than 2 paragraphs (docs, SOPs, copy) → use the echo agent
- Architecture decisions, cost analysis, planning → use the nova agent
- UI/UX design, styling, layout → use the prism agent
- Image analysis → use the optic agent

**I handle directly:**
- Quick factual answers from context I already have
- Coordinating between agents
- Reviewing agent output before presenting to Joshua
- Clarifying questions

**When in doubt → delegate.**

## Workflow
1. Assess what Joshua needs
2. Check if I already have the answer in project context
3. Delegate to the right agent(s) with clear instructions
4. Review their output for quality and accuracy
5. Present the result to Joshua

Always say "Delegating to [agent name]..." so Joshua can see the process.

## CAKE business context
- CAKE is a cannabis cultivation and processing company in Oklahoma
- Operations span grow, processing, packaging, sales, compliance, and transportation
- Related dispensary: TJD Supplements (separate entity, shared cost structures)
- Sales tax set-aside: ~$351/day based on current sales
- OMMA compliance is critical — Oklahoma Medical Marijuana Authority regulations
- Also see: cake-site, cake-menu, cake-vault, packaging repos for other CAKE tools

## Tech stack

**Framework:** Next.js 16.1.4 (App Router, Turbopack) + React 19.1.0 + TypeScript 5
**Styling:** Tailwind CSS v4 + shadcn/ui (Radix UI v1 primitives)
**Database:** Supabase — vault project (`spkimmrtaxwnysjqkxix`)
**Auth:** PIN-only session auth — 4-digit PIN, signed HttpOnly `crm-session` cookie (HMAC-SHA256, `SESSION_SECRET`), 7-day sliding TTL. Client mirrors it in `localStorage['crm-user']` for UI only. See "Auth architecture" under Known issues for detail; the old Supabase-Auth "shadow auth" path has been removed.
**PWA:** Serwist 9.5.3 (service worker at `app/sw.ts`, manifest at `app/manifest.json`)
**Testing:** Vitest configured, with real coverage on the auth/session layer (see Known issues)
**Deployment:** Vercel via `vercel --prod`
**Key libraries:**
  - UI: Sonner 2.0.7 (toasts), lucide-react 0.542.0 (icons), cmdk 1.1.1 (command palette)
  - Date: date-fns 4.1.0, react-day-picker 9.13.0
  - Supabase: @supabase/supabase-js 2.56.1, @supabase/ssr 0.7.0
  - Styling: class-variance-authority 0.7.1, clsx 2.1.1, tailwind-merge 3.3.1
  - Theme: next-themes 0.4.6

## Project context

**What this is:**
cake-app started as a standalone CRM but has evolved into the unified CAKE Platform — a single app covering vault inventory, packaging tasks, orders, dispensary management, communications, and sales commissions. It replaced three separate apps (vault-inventory, packaging dashboard, CRM) under one codebase pointed at a single Supabase project.

**What's built and working:**

- **Auth system** (`/login`, `lib/auth-context.tsx`, `lib/auth/session.ts`) — signed-cookie PIN session (see "Auth architecture" under Known issues), role-based nav, permission helpers (canCreateOrder, canApproveOrder, canEditOrder, canDeleteOrder, canManageUsers, canAssignSales). The `auth_id` column and Supabase-Auth sign-in are vestigial — not used by the current auth flow.

- **Vault** (`/dashboard/vault`) — bulk package management, weight tracking, transaction history, batch/strain/product type admin at `/vault/admin`. Includes server actions in `actions/vault.ts` for package CRUD, weight adjustments, batch management, and transaction logging. Types in `types/vault.ts` define VaultPackage, Transaction, Batch with `is_active` flag, Strain, and ProductType.

- **Packaging** (`/dashboard/packaging`) — Full Kanban task board (TO FILL → TO CASE → DONE), real-time inventory levels across containers, container management (add/edit/remove), task notes with cross-device sync, undo functionality, task state persistence in `packaging_task_state` table. Allocation engine at `lib/packaging/allocation-engine.ts` handles URGENT/TOMORROW/UPCOMING/BACKFILL priority logic. Database layer at `lib/packaging/db.ts` provides Supabase queries. Server actions in `actions/packaging.ts` (main) and `actions/packaging-v2.ts` (WIP with materials integration).

- **Inventory dashboard** (`/dashboard/inventory`) — Real-time inventory levels across SKUs, aggregates from vault packages and tracks against packaging needs.

- **Materials** (`/dashboard/materials`) — Materials inventory tracking (jars, lids, mylar bags, labels). Server actions in `actions/materials.ts`. Integration with packaging is WIP (imports commented out in `actions/packaging-v2.ts`).

- **Orders** (`/dashboard/orders`) — Full order lifecycle (pending → confirmed → packed → delivered), table and card views, in-sheet editing with case-based quantities, customer-level pricing via `customer_pricing` table, delivery date tracking. Order editing restricted to admin/management roles. Sales can create orders for assigned accounts only.

- **Dispensaries** (`/dashboard/dispensaries`) — Customer profiles with DBA name, license name, contact management (multiple contacts per dispensary via `contacts` table), sales rep assignment (`assigned_sales_id`), customer-specific pricing, auto-assignment of new dispensaries to creating sales user. Server actions in `actions/contacts.ts` for contact CRUD.

- **Communications** (`/dashboard/communications`) — Communication logging per dispensary with type (call, email, meeting, note), date/time tracking, user attribution.

- **Tasks** (`/dashboard/tasks`) — General task management (separate from packaging tasks).

- **Products** (`/dashboard/products`) — SKU management, implemented as a VIEW over vault skus table. Product sheet component for editing, SKU materials tracking.

- **Commissions** (`/dashboard/commissions`, `/dashboard/commissions/rates`, `/dashboard/my-commissions`) — Commission rates by salesperson/SKU/product type with price tier overrides, auto-calculated on delivery via DB trigger (`calculate_commission_on_delivery`), approval workflow (pending → approved → paid). System uses `commission_rates` and `commissions` tables. DB schema created in migration `20260202022500_create_commission_system.sql` with price tier enhancements in `20260202032800_add_price_tiers_to_commissions.sql`.

- **Users** (`/dashboard/users`) — User management with role system (admin, management, sales, agent, vault, packaging, standard). Admin-only access.

**What's incomplete / known issues:**

1. **Test coverage is auth/session-only** — `vitest.config.ts` exists (node environment, `@/` alias mirroring `tsconfig.json`) and there are 8 test files / 84 passing tests: `lib/auth/session.test.ts`, `lib/auth/session-edge.test.ts`, `lib/auth/session-errors.test.ts`, `lib/auth/session-constants.test.ts`, `lib/auth-context.test.ts`, `lib/supabase/middleware.test.ts`, `actions/auth.test.ts`, `app/login/sanitize-next-path.test.ts`. Everything else in the app — orders, vault, packaging, commissions, finance — has zero test coverage.

2. **Materials integration with packaging** — `actions/packaging-v2.ts` has material deduction logic but imports are commented out: `// DISABLED: Materials imports - re-enable when materials module is complete`. The materials tracking system is built (`materials_inventory` table, materials dashboard) but not wired into the packaging task completion flow.

3. **Old packaging components** — Legacy components still in repo at `components/packaging/`: `TaskQueue.tsx`, `TaskRow.tsx`, `RefreshControls.tsx`. These were replaced by the new Kanban board but weren't deleted. Should be removed.

4. **Monorepo** — Phase 4 goal not complete. Packaging TV display (at process.cakeoklahoma.com) and cake-app are still separate repos. No monorepo setup exists (no `pnpm-workspace.yaml`, no Turborepo config).

5. **Deprecate cake-crm Supabase project** — Old Supabase project `jwsidjgsjohhrntxdljp` is still active (mentioned in todos.md Phase 3). Vault project (`spkimmrtaxwnysjqkxix`) is the live one. Old project should be archived/deleted.

6. **Sales "Assigned Accounts" section** — Listed as future enhancement in todos.md. User profile page doesn't show which dispensaries are assigned to each sales user. Would be useful for sales management.

7. **Commission system production testing** — DB schema and UI are built (complex 800+ line pages with rate management, approval workflows, tiered pricing), but real-world production testing with actual sales data may be limited. Commission calculation trigger is in place but hasn't been battle-tested at scale.

8. **Production URL not documented** — The deployed production URL for the CAKE Platform isn't documented in the repo. Only the packaging TV display URL (process.cakeoklahoma.com) is mentioned.

9. **Auth architecture** — The PIN session is the *only* auth system now; the old Supabase-Auth "shadow auth" (`signInWithPassword` with credentials derived from user id + PIN) has been removed entirely. Session state: an HMAC-SHA256-signed HttpOnly cookie `crm-session`, payload `<userId>.<signature>`, 7-day TTL, signed with `SESSION_SECRET`. Verified server-side by `verifySession()`/`checkSession()`/`requireRole()` in `lib/auth/session.ts` (Node crypto) and, for the middleware gate, by `lib/auth/session-edge.ts` (Web Crypto) — the two must stay byte-identical in behavior. The role is always re-read fresh from `public.users`, never trusted from the cookie. Nothing depends on `auth.uid()` / RLS — every server action uses `createServiceClient()` (service-role, bypasses RLS), so **RLS is not a backstop in this app; authorization is enforced solely in application code via `requireRole()`**. A server action without a `requireRole()` guard is unauthenticated and world-callable. Client state lives in `localStorage['crm-user']` for UI purposes only and is reconciled against the server on mount, on tab refocus, and on a 30-minute heartbeat (for unattended kiosk/TV displays). `handleSessionError()` from `useAuth()` is the single authoritative path for reacting to an expired session — route server-action errors through it rather than rendering ad hoc "session expired" copy.

10. **TypeScript/ESLint errors ignored in builds** — `next.config.ts` has `ignoreBuildErrors: true` and `ignoreDuringBuilds: true`. This means type errors and lint errors don't block production deploys. While pragmatic for rapid iteration, it increases risk of runtime errors.

**Role system:**
| Role | Access |
|------|--------|
| `admin` | Everything including user management |
| `management` | Everything except user management |
| `sales` | Dispensaries, Orders, Comms, Tasks, My Commissions |
| `agent` | Same as sales |
| `vault` | Vault, Packaging, Inventory, Products |
| `packaging` | Packaging, Materials, Inventory, Products |
| `standard` | Vault, Packaging, Products |
| `grow` | Cultivation (view + complete tasks), Cultivation monitor |

Permissions are enforced via helper functions in `lib/auth-context.tsx`: `canViewSection()`, `canCreateOrder()`, `canApproveOrder()`, `canEditOrder()`, `canDeleteOrder()`, `canManageUsers()`, `canAssignSales()`.

## Local development

```bash
npm install
npm run dev     # starts on localhost:3000 with Turbopack
```

**Required `.env.local`:**
```
NEXT_PUBLIC_SUPABASE_URL=https://spkimmrtaxwnysjqkxix.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service role key>
SESSION_SECRET=<generate with: openssl rand -hex 32>
DATA_SOURCE=supabase
```

- `SUPABASE_SERVICE_ROLE_KEY` — required. `createServiceClient()` (`lib/supabase/server.ts`) throws without it, and nearly every server action goes through that client.
- `SESSION_SECRET` — required, and mandatory as of the auth rework: with it unset, `authenticateByPin` fails closed (no one can log in) and middleware redirects every `/dashboard` and `/cultivation-display` document navigation to `/login` — a total lockout with no in-app recovery. Generate with `openssl rand -hex 32`. In Vercel it's currently set for Production and Preview only, not Development — a fresh local checkout has no value for it until you add one to `.env.local`. Rotating it invalidates every outstanding `crm-session` cookie and logs every user out at once. Adding or changing it in Vercel requires a redeploy to take effect.

Note: `.env.local` is gitignored (see `.gitignore` lines 34, 42) — you'll need to create it from the Supabase vault project dashboard. No `.env.example` file exists in the repo currently.

**Other scripts:**
```bash
npm run build         # production build with Turbopack
npm run start         # start production server
npm run lint          # ESLint (v9)
npm run type-check    # TypeScript check (tsc --noEmit)
npm test              # Vitest — 8 test files / 84 tests, all on the auth/session layer
npm run test:ui       # Vitest with UI
npm run test:coverage # Vitest with coverage report
vercel --prod         # deploy to production (requires Vercel CLI v50.1.6+)
```

**Development notes:**
- `middleware.ts` (via `lib/supabase/middleware.ts`) is the server-side auth enforcement point, not just session refresh — see "Important files" below for what it actually gates
- PWA manifest at `app/manifest.json`, service worker at `app/sw.ts`
- Turbopack is used for both dev and build (faster than webpack)
- `next.config.ts` has `ignoreBuildErrors: true` and `ignoreDuringBuilds: true` — TypeScript/ESLint errors won't block builds

## Conventions
- Conventional commits
- Commit directly to main (current workflow — no feature branch requirement in practice)
- Tailwind CSS v4 for styling (new oxide engine)
- Mobile-first design — used on phones by sales/warehouse staff
- TypeScript 5 (strict mode not enforced in builds)
- shadcn/ui for all new UI components (40+ components in `components/ui/`)
- Server Actions for data mutations (`actions/` directory — all operations go through server actions)
- Supabase MCP for schema changes (`apply_migration`) and data queries
- React 19.1.0 features used (Server Components, Server Actions, new hooks)

## Important files

```
# Auth & Session
lib/auth-context.tsx              # PIN auth, session, permission helpers (canCreateOrder, etc.)
lib/auth/session.ts               # Cookie sign/verify/clear, checkSession()/verifySession()/requireRole() (Node crypto)
lib/auth/session-edge.ts          # Edge-safe (Web Crypto) mirror of the signature check, for middleware
lib/supabase/client.ts            # Supabase browser client
lib/supabase/server.ts            # Supabase server client (createClient, createServiceClient)
lib/supabase/middleware.ts        # Auth enforcement: verifies crm-session, redirects unauthenticated document
                                   #   navigations for PROTECTED_PREFIXES (/dashboard, /cultivation-display),
                                   #   slides the cookie forward. Add new authenticated top-level routes to
                                   #   PROTECTED_PREFIXES here or they ship with no server-side gate. Deliberately
                                   #   does NOT redirect non-document requests (Server Action POSTs, RSC fetches) —
                                   #   those must reach the server so requireRole() can fail closed with
                                   #   "No valid session"; redirecting them was a real bug that broke session-expiry
                                   #   detection and must not be "tidied up" later.
middleware.ts                     # Next.js middleware entry point, delegates to lib/supabase/middleware.ts

# Packaging Core Logic
lib/packaging/allocation-engine.ts # Task generation logic (URGENT/TOMORROW/UPCOMING/BACKFILL)
lib/packaging/db.ts               # Packaging data layer (Supabase queries)
lib/packaging/types.ts            # Packaging TypeScript types
lib/packaging/utils.ts            # Packaging utility functions

# Server Actions (Data Mutations)
actions/auth.ts                   # Auth-related server actions
actions/vault.ts                  # Vault server actions (packages, batches, transactions)
actions/packaging.ts              # Packaging server actions (main - task management)
actions/packaging-v2.ts           # Packaging server actions v2 (materials integration WIP)
actions/materials.ts              # Materials inventory server actions
actions/contacts.ts               # Contact management server actions

# Type Definitions
types/database.ts                 # Supabase-generated TypeScript DB types (regenerate after migrations)
types/vault.ts                    # Vault-specific types (VaultPackage, Transaction, Batch, Strain)
types/packaging.ts                # Packaging-specific types (InventoryLevel, PackagingTask)

# Database
supabase/migrations/              # All DB migrations (chronological, 9 migrations)
  20250904221317_create_product_pricing.sql
  20260129153500_add_is_active_to_packages.sql
  20260131120000_create_materials_inventory.sql
  20260131163000_create_contacts.sql
  20260201074600_add_license_name_to_customers.sql
  20260201180000_add_customer_filter_fields.sql
  20260202022500_create_commission_system.sql
  20260202032800_add_price_tiers_to_commissions.sql
  20260218140000_add_auth_id.sql

# Core Utilities
lib/utils.ts                      # cn() utility (clsx + tailwind-merge), shared helpers

# Documentation
decisions.md                      # Architecture decisions log (deployment tools, auth choices)
progress.md                       # Session-by-session changelog
todos.md                          # Current status, outstanding work, phase tracker
MASTER_CONSOLIDATION_PLAN.md      # Full platform consolidation context (referenced in todos.md)

# Config
next.config.ts                    # Next.js config with Serwist PWA setup
package.json                      # Dependencies and scripts
tsconfig.json                     # TypeScript configuration
tailwind.config.ts                # Tailwind CSS v4 config
```

**Key page routes:**
```
app/login/page.tsx                # PIN login page
app/dashboard/page.tsx            # Main dashboard (role-aware)
app/dashboard/vault/page.tsx      # Vault package management
app/dashboard/vault/admin/page.tsx # Batch/strain/product type admin
app/dashboard/packaging/page.tsx  # Packaging Kanban board
app/dashboard/inventory/page.tsx  # Inventory levels dashboard
app/dashboard/materials/page.tsx  # Materials inventory
app/dashboard/orders/page.tsx     # Order management
app/dashboard/dispensaries/page.tsx # Dispensary profiles
app/dashboard/communications/page.tsx # Communication logs
app/dashboard/tasks/page.tsx      # Task management
app/dashboard/products/page.tsx   # SKU management
app/dashboard/commissions/page.tsx # Commission overview
app/dashboard/commissions/rates/page.tsx # Commission rate management
app/dashboard/my-commissions/page.tsx # Individual commission view
app/dashboard/users/page.tsx      # User management (admin only)
```

**Key component files:**
```
components/ui/                    # 40+ shadcn/ui components (button, dialog, sheet, table, etc.)
components/orders/order-sheet.tsx # Order creation/editing sheet
components/dispensaries/contact-sheet.tsx # Contact management
components/dispensaries/dispensary-contacts.tsx # Contact list
components/dispensary/customer-pricing.tsx # Customer-specific pricing
components/dispensary/edit-dispensary-sheet.tsx # Dispensary edit form
components/products/product-sheet.tsx # Product editing
components/products/sku-materials.tsx # SKU materials tracking
components/communications/communication-sheet.tsx # Communication log entry
```

## Supabase (vault project)

**Project ID:** `spkimmrtaxwnysjqkxix`
**URL:** https://spkimmrtaxwnysjqkxix.supabase.co

**Key tables:**
- **Auth & Users:** `users` (with `auth_id`, role enum)
- **CRM:** `customers` (dispensaries), `contacts`, `communications`, `tasks`
- **Orders:** `orders`, `order_items` (with generated `line_total` column)
- **Products:** `products`, `skus`, `sku_pricing`, `customer_pricing`
- **Vault:** `packages`, `batches`, `strains`, `product_types`, `transactions`
- **Packaging:** `containers`, `packaging_tasks`, `packaging_task_state`, `task_notes`, `inventory_log`
- **Materials:** `materials_inventory`
- **Commissions:** `commission_rates`, `commissions`
- **Views:** `inventory` (aggregated SKU inventory levels)

**Database functions/triggers:**
- `calculate_commission_on_delivery()` — Trigger function that auto-calculates commissions when orders are marked as delivered

**Apply schema changes:**
```bash
# Use Supabase MCP tool
mcp__supabase__apply_migration
```

**Regenerate TypeScript types after schema changes:**
```bash
# Use Supabase MCP tool to generate types
mcp__supabase__generate_typescript_types

# Update types/database.ts with the output
```

**Other Supabase MCP tools available:**
- `mcp__supabase__list_tables` — List all tables
- `mcp__supabase__execute_sql` — Run SELECT/INSERT/UPDATE/DELETE
- `mcp__supabase__list_migrations` — View applied migrations
- `mcp__supabase__get_logs` — Get logs by service (api, postgres, auth)
- `mcp__supabase__get_advisors` — Security/performance recommendations

## Deployment

- **Production URL:** Not explicitly documented in repo (needs to be added)
- **Deploy command:** `vercel --prod` (Vercel CLI v50.1.6+, no GitHub Actions)
- **Packaging TV display** (separate app): https://process.cakeoklahoma.com
- **Platform:** Vercel (Next.js 16 with Turbopack)
- **Database:** Supabase vault project (managed, hosted)

**Deployment workflow:**
1. Commit changes to main branch (no feature branches required)
2. Run `vercel --prod` via CLI
3. Vercel builds with Turbopack and deploys
4. Database schema changes via Supabase MCP (migrations applied directly)

## Current priorities
<!-- Joshua updates this as needed -->
