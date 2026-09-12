# CAKE Platform Knowledge Base

> Detailed technical reference for the unified CAKE Platform (cake-app repo).
> Complements `CLAUDE.md` -- read that first for project overview, conventions, and business context.
> Last updated: 2026-03-31

---

## 1. Architecture Overview

### System Diagram

```
                        +---------------------------+
                        |      Vercel (Hosting)      |
                        |   Next.js 16 App Router    |
                        +---------------------------+
                                    |
                  +-----------------+-----------------+
                  |                                   |
          +-------v--------+               +---------v--------+
          |  Server Actions |               |  React Client    |
          |  (actions/*.ts) |               |  Components      |
          +-------+--------+               +---------+--------+
                  |                                   |
                  |  Supabase JS SDK                  |  localStorage
                  |  (server client)                  |  (crm-user session)
                  |                                   |
          +-------v--------+               +---------v--------+
          |   Supabase DB   |               |  Browser Client  |
          |  (vault project) |<-------------|  (lib/supabase/  |
          |  spkimmrtaxwnysjqkxix           |   client.ts)     |
          +-----------------+               +------------------+
```

### Data Flow Pattern

All mutations follow the same pattern:

```
User Action (click/submit)
  -> React Component calls Server Action (actions/*.ts)
    -> Server Action creates Supabase server client
      -> Supabase query (INSERT/UPDATE/DELETE)
        -> Returns result
      -> Server Action returns { success, error, data }
    -> Component updates local state / shows toast
  -> Page may call router.refresh() or revalidatePath()
```

Read operations are typically done in page-level Server Components that fetch data and pass it as props to client components.

### Dual Auth System

Two auth mechanisms coexist:

| Mechanism | Users | Session Storage | Implementation |
|-----------|-------|----------------|----------------|
| PIN Auth | Warehouse staff (vault, packaging, standard) | `localStorage` as `crm-user` | `actions/auth.ts` -> `authenticateByPin()` |
| Supabase Auth | Sales/CRM users (planned) | Supabase session cookie | `users.auth_id` column, `middleware.ts` |

**How they connect:** PIN auth creates a "shadow" Supabase Auth account (`{user_id}@cake.internal`) so that RLS policies work for PIN-authenticated users. The PIN user's session is stored client-side in localStorage, while Supabase Auth manages the actual DB session.

**Auth flow:**
1. User enters 4-digit PIN on `/login`
2. `authenticateByPin()` server action validates PIN against `users` table
3. Shadow Supabase Auth sign-in occurs (email: `{id}@cake.internal`, password: deterministic hash)
4. User object `{ id, name, role }` saved to localStorage as `crm-user`
5. `AuthProvider` context makes user available via `useAuth()` hook
6. Role-based nav filtering in `app/dashboard/layout.tsx`

---

## 2. Database Reference

### Table Catalog

#### Auth & Users

| Table | Description | Key Columns |
|-------|-------------|-------------|
| `users` | All platform users | `id` (UUID PK), `name`, `pin` (4-digit), `role`, `auth_id` (nullable UUID), `email` (nullable, unique) |
| `profiles` | VIEW over users | Alias/join used in some migrations |

#### Vault System

| Table | Description | Key Columns |
|-------|-------------|-------------|
| `product_types` | Cannabis product categories | `id` (UUID PK), `name` |
| `strains` | Cannabis strain definitions | `id` (UUID PK), `name` |
| `batches` | Harvest batches per strain | `id` (UUID PK), `name`, `strain_id` (FK), `is_active` (bool) |
| `packages` | Bulk cannabis packages | `tag_id` (TEXT PK), `batch`, `strain`, `strain_id` (FK), `type_id` (FK), `current_weight`, `is_active`, `created_by` (FK) |
| `transactions` | Package weight audit log | `id` (UUID PK), `tag_id` (FK), `user_id` (FK), `type` (add/remove), `amount`, `resulting_balance` |

#### Products & Pricing

| Table | Description | Key Columns |
|-------|-------------|-------------|
| `skus` | Stock keeping units (14 total) | `id` (UUID PK), `code` (e.g. "BG"), `name`, `strain_id` (FK), `product_type_id` (FK), `price_per_unit`, `units_per_case`, `in_stock` |
| `products` | VIEW joining skus+strains+product_types | `item_name`, `strain_name`, `category` |
| `sku_pricing` | Tiered pricing per SKU | `id`, `sku_id` (FK), `min_quantity`, `price` |
| `product_pricing` | Legacy tiered pricing | `id`, `product_id` (FK), `min_quantity`, `price` |
| `customer_pricing` | Per-customer pricing overrides | `id`, `customer_id` (FK), `sku_id` (FK), `product_type_id` (FK), `price_per_unit` |

**Pricing hierarchy:** customer item-level (sku_id) > customer category-level (product_type_id) > SKU default price

#### Materials System

| Table | Description | Key Columns |
|-------|-------------|-------------|
| `materials` | Packaging material catalog | `id`, `name`, `sku_code`, `material_type` (bag_strain/bag_generic/tray/sticker/other), `current_stock`, `low_stock_threshold` |
| `sku_materials` | Junction: SKUs to materials | `id`, `sku_id` (FK), `material_id` (FK), `quantity_per_unit` |
| `material_transactions` | Material stock audit log | `id`, `material_id` (FK), `quantity` (+/-), `transaction_type` (usage/restock/adjustment/initial), `sku_id`, `user_id`, `notes` |

#### Packaging System

| Table | Description | Key Columns |
|-------|-------------|-------------|
| `inventory` | Per-SKU inventory levels | `sku_id` (UUID PK), `cased`, `filled`, `staged` |
| `packaging_task_state` | Persisted Kanban task positions | `id`, `task_key`, `sku`, `task_type` (FILL/CASE), `current_column` (TO_FILL/TO_CASE/DONE), `quantity`, `completed_at` |

#### Orders & Customers

| Table | Description | Key Columns |
|-------|-------------|-------------|
| `customers` | Dispensary profiles | `id`, `business_name`, `license_name`, `address`, `city`, `omma_license`, `ob_license`, `assigned_sales_id` (FK), `has_orders`, `order_count`, `first_order_date`, `last_order_date` |
| `orders` | Order records | `id`, `order_number` (auto ORD-XXXX), `customer_id` (FK), `agent_id` (FK), `status` (pending/confirmed/packed/delivered/cancelled), `packed_at`, `delivered_at`, `total_price`, `approved_by`, `approved_at` |
| `order_items` | Line items per order | `id`, `order_id` (FK, CASCADE), `sku_id` (FK), `quantity`, `unit_price`, `line_total` (GENERATED) |
| `contacts` | Per-dispensary contacts | `id`, `dispensary_id` (FK), `name`, `email`, `phone`, `role` (owner/manager/inventory_manager/buyer/other), `is_primary` |
| `communications` | Interaction logs | `id`, `agent_id` (FK), `customer_id` (FK), `interaction_date`, `notes`, `contact_method` (phone/email/in-person/text), `follow_up_required` |
| `sales_tasks` | General CRM tasks | `id`, `agent_id` (FK), `customer_id` (FK), `title`, `description`, `due_date`, `status` (pending/complete), `priority` (1-3) |

#### Commission System

| Table | Description | Key Columns |
|-------|-------------|-------------|
| `commission_rates` | Rate configuration | `id`, `salesperson_id` (FK, nullable=global), `product_type_id` (FK), `sku_id` (FK), `min_unit_price`, `rate_percent`, `effective_from`, `effective_to` |
| `commissions` | Earned commission records | `id`, `order_id` (FK, UNIQUE), `salesperson_id` (FK), `order_total`, `commission_amount`, `rate_applied`, `status` (pending/approved/paid), `paid_at`, `paid_by` |

### Key Relationships

```
strains --< batches --< packages >-- product_types
strains --< skus >-- product_types
skus --< sku_pricing
skus --< sku_materials >-- materials
materials --< material_transactions
skus --< order_items >-- orders >-- customers
customers --< contacts
customers --< communications >-- users
customers --< sales_tasks >-- users
customers.assigned_sales_id --> users
orders.agent_id --> users
commissions --> orders (UNIQUE)
commissions --> users (salesperson)
commission_rates --> users (salesperson, nullable)
commission_rates --> product_types (nullable)
commission_rates --> skus (nullable)
```

### Database Functions & Triggers

| Function | Type | Description |
|----------|------|-------------|
| `get_commission_rate(salesperson_id, sku_id, product_type_id, date)` | Function | Returns applicable rate using hierarchy: SKU > product_type > salesperson > global |
| `calculate_order_commission(order_id)` | Function | Calculates commission amount for an order |
| `create_commission_on_delivery()` | Trigger (orders AFTER UPDATE) | Auto-creates commission when order status changes to 'delivered' |
| `update_customer_order_stats()` | Trigger (orders AFTER INSERT/UPDATE/DELETE) | Updates denormalized stats on customers (has_orders, order_count, dates) |
| `update_updated_at_column()` | Trigger helper | Sets `updated_at = NOW()` on row update |

### RLS Policies

RLS is enabled on: `materials`, `sku_materials`, `material_transactions`, `product_pricing`, `contacts`, `communications`, `orders`, `order_items`, `customers`, `sales_tasks`, `commission_rates`, `commissions`

Key pattern: Most tables use permissive policies allowing all authenticated users (necessary because PIN auth creates shadow Supabase Auth accounts). Management/admin have additional write policies on materials and pricing tables.

### Migration History

| # | Migration | What It Does |
|---|-----------|--------------|
| 1 | `20250904221317` | Create `product_pricing` table (tiered pricing) |
| 2 | `20260129153500` | Add `is_active` to `packages` (batch hiding) |
| 3 | `20260131120000` | Create materials system (`materials`, `sku_materials`, `material_transactions`) |
| 4 | `20260131163000` | Create `contacts` table |
| 5 | `20260201074600` | Add `license_name` to `customers` |
| 6 | `20260201180000` | Add customer filter fields + `update_customer_order_stats` trigger |
| 7 | `20260202022500` | Create commission system (tables, functions, triggers) |
| 8 | `20260202032800` | Add price tiers to commissions (`min_unit_price`) |
| 9 | `20260218140000` | Add `auth_id` to `users` (Supabase Auth link) |
| 10 | `20260318230000` | Recreate `products` view (join skus+strains+product_types) |
| 11 | `20260320000000` | Fix communications RLS for PIN auth (permissive policies) |

---

## 3. Feature Module Map

### Vault (Bulk Package Management)

| Attribute | Detail |
|-----------|--------|
| **Routes** | `/dashboard/vault`, `/dashboard/vault/admin` |
| **Pages** | `app/dashboard/vault/page.tsx`, `app/dashboard/vault/admin/page.tsx` |
| **Server Actions** | `actions/vault.ts` (841 lines) |
| **DB Tables** | `packages`, `batches`, `strains`, `product_types`, `transactions` |
| **Status** | Working |

Key actions: `getFilteredPackages()`, `adjustWeight()`, `createPackage()`, `updatePackage()`, `deletePackage()`, `toggleBatchActive()`, `getRecentTransactions()`

### Packaging (Kanban Task Board)

| Attribute | Detail |
|-----------|--------|
| **Routes** | `/dashboard/packaging` |
| **Pages** | `app/dashboard/packaging/page.tsx` |
| **Server Actions** | `actions/packaging.ts` (440 lines), `actions/packaging-v2.ts` (477 lines, WIP) |
| **Core Logic** | `lib/packaging/allocation-engine.ts`, `lib/packaging/db.ts`, `lib/packaging/types.ts`, `lib/packaging/utils.ts` |
| **DB Tables** | `inventory`, `packaging_task_state`, `orders`, `order_items` |
| **Status** | Working (materials integration WIP) |

Allocation engine priority tiers: URGENT (today) > TOMORROW > UPCOMING (2-3 days) > BACKFILL (stock building, target=8).
Auto-refresh interval: 2.5 minutes (150000ms).
3-column Kanban: TO_FILL -> TO_CASE -> DONE.

### Orders (Order Lifecycle)

| Attribute | Detail |
|-----------|--------|
| **Routes** | `/dashboard/orders`, `/dashboard/orders/new` |
| **Pages** | `app/dashboard/orders/page.tsx`, `app/dashboard/orders/new/page.tsx` |
| **Components** | `components/orders/order-sheet.tsx` |
| **DB Tables** | `orders`, `order_items`, `customers`, `skus`, `customer_pricing` |
| **Status** | Working |

Status flow: `pending -> confirmed -> packed -> delivered` (also `cancelled`).
Case-based ordering: users input cases, system calculates units (cases x units_per_case).
`order_items.line_total` is a PostgreSQL GENERATED column (read-only).
Order numbers use a PostgreSQL sequence (ORD-XXXX format).

**Inventory deduction logic** (in `lib/packaging/db.ts`):
- `packed`: deduct from CASED inventory (only if `packed_at` was null -- prevents double deduction)
- `delivered`: deduct from CASED + create commission (only if `delivered_at` was null)
- Revert packed->pending: restore CASED amount

### Dispensaries (Customer Profiles)

| Attribute | Detail |
|-----------|--------|
| **Routes** | `/dashboard/dispensaries`, `/dashboard/dispensaries/new`, `/dashboard/dispensaries/[id]` |
| **Pages** | `app/dashboard/dispensaries/page.tsx`, `app/dashboard/dispensaries/new/page.tsx`, `app/dashboard/dispensaries/[id]/page.tsx` |
| **Components** | `components/dispensary/edit-dispensary-sheet.tsx`, `components/dispensary/customer-pricing.tsx`, `components/dispensaries/contact-sheet.tsx`, `components/dispensaries/dispensary-contacts.tsx` |
| **Server Actions** | `actions/contacts.ts` (281 lines) |
| **DB Tables** | `customers`, `contacts`, `customer_pricing` |
| **Status** | Working |

Auto-assignment: when a sales user creates a dispensary, `assigned_sales_id` is automatically set to the creating user.
Pagination: 50 per page. Filters: search, city, sales rep, has_orders, date range.

### Communications (Interaction Logging)

| Attribute | Detail |
|-----------|--------|
| **Routes** | `/dashboard/communications`, `/dashboard/communications/new` |
| **Pages** | `app/dashboard/communications/page.tsx`, `app/dashboard/communications/new/page.tsx` |
| **Components** | `components/communications/communication-sheet.tsx` |
| **DB Tables** | `communications` |
| **Status** | Working |

Contact methods: phone, email, in-person, text.
Edit tracking via `is_edited`, `last_edited_at`, `last_edited_by`.

### Tasks (Sales Tasks)

| Attribute | Detail |
|-----------|--------|
| **Routes** | `/dashboard/tasks`, `/dashboard/tasks/new` |
| **Pages** | `app/dashboard/tasks/page.tsx`, `app/dashboard/tasks/new/page.tsx` |
| **DB Tables** | `sales_tasks` |
| **Status** | Working |

Note: These are general CRM tasks, completely separate from packaging tasks (`packaging_task_state`).
Priority levels: 1=high, 2=medium, 3=low.

### Products (SKU Management)

| Attribute | Detail |
|-----------|--------|
| **Routes** | `/dashboard/products`, `/dashboard/products/new` |
| **Pages** | `app/dashboard/products/page.tsx`, `app/dashboard/products/new/page.tsx` |
| **Components** | `components/products/product-sheet.tsx`, `components/products/sku-materials.tsx` |
| **DB Tables** | `skus`, `products` (VIEW), `sku_materials`, `sku_pricing` |
| **Status** | Working |

14 SKUs: BG, BG-B, BB, BB-B, BIS, BIS-B, CM, CM-B, CR, CR-B, MAC, MAC-B, VZ, VZ-B.
`products` is a VIEW joining skus with strains and product_types.

### Materials (Packaging Material Inventory)

| Attribute | Detail |
|-----------|--------|
| **Routes** | `/dashboard/materials` |
| **Pages** | `app/dashboard/materials/page.tsx` |
| **Server Actions** | `actions/materials.ts` (827 lines) |
| **DB Tables** | `materials`, `sku_materials`, `material_transactions` |
| **Status** | Working (but not wired into packaging completion flow) |

Material types: bag_strain, bag_generic, tray, sticker, other.

### Inventory Dashboard

| Attribute | Detail |
|-----------|--------|
| **Routes** | `/dashboard/inventory` |
| **Pages** | `app/dashboard/inventory/page.tsx` |
| **DB Tables** | `inventory`, `packages` |
| **Status** | Working |

Aggregated view showing cased/filled/staged levels per SKU.

### Commissions

| Attribute | Detail |
|-----------|--------|
| **Routes** | `/dashboard/commissions`, `/dashboard/commissions/rates`, `/dashboard/my-commissions` |
| **Pages** | `app/dashboard/commissions/page.tsx`, `app/dashboard/commissions/rates/page.tsx`, `app/dashboard/my-commissions/page.tsx` |
| **DB Tables** | `commission_rates`, `commissions` |
| **Status** | Working (not battle-tested at scale) |

Rate hierarchy: SKU-specific > product_type > salesperson default > global default.
Price tiers: `min_unit_price` threshold overrides rate at price level.
Workflow: order delivered (trigger) -> pending -> approved (admin) -> paid (admin).

### Users (User Management)

| Attribute | Detail |
|-----------|--------|
| **Routes** | `/dashboard/users`, `/dashboard/users/new` |
| **Pages** | `app/dashboard/users/page.tsx`, `app/dashboard/users/new/page.tsx` |
| **DB Tables** | `users` |
| **Status** | Working (admin only) |

---

## 4. Auth & Permissions Reference

### Complete Role-Section Matrix

| Section | admin | management | sales | agent | vault | packaging | standard |
|---------|:-----:|:----------:|:-----:|:-----:|:-----:|:---------:|:--------:|
| Dashboard | Y | Y | Y | Y | Y | Y | Y |
| Vault | Y | Y | - | - | Y | - | Y |
| Packaging | Y | Y | - | - | Y | Y | Y |
| Inventory | Y | Y | - | - | Y | Y | - |
| Materials | Y | Y | - | - | - | Y | - |
| Orders | Y | Y | Y | Y | - | - | - |
| Dispensaries | Y | Y | Y | Y | - | - | - |
| Communications | Y | Y | Y | Y | - | - | - |
| Tasks | Y | Y | Y | Y | - | - | - |
| My Commissions | Y | Y | Y | Y | - | - | - |
| Products | Y | Y | - | - | Y | Y | Y |
| Commissions (admin) | Y | Y | - | - | - | - | - |
| Users | Y | - | - | - | - | - | - |

### Permission Helper Functions

All defined in `lib/auth-context.tsx`:

| Function | Returns true for |
|----------|-----------------|
| `canViewSection(role, section)` | See matrix above |
| `canCreateOrder(role)` | admin, management, sales |
| `canApproveOrder(role)` | admin, management |
| `canEditOrder(role)` | admin, management |
| `canDeleteOrder(role)` | admin, management |
| `canManageUsers(role)` | admin |
| `canAssignSales(role)` | admin, management, sales, agent |

### Sales Account Scoping

- `customers.assigned_sales_id` links each dispensary to a sales user
- Sales users can only create orders for their assigned dispensaries
- Management/admin can create orders for any customer
- Auto-assignment: creating a dispensary as a sales user sets `assigned_sales_id` to your user ID

---

## 5. Server Actions Catalog

### `actions/auth.ts` (49 lines)

| Action | Parameters | Tables | Description |
|--------|-----------|--------|-------------|
| `authenticateByPin` | `pin: string` | `users` | Validates 4-digit PIN, creates shadow Supabase Auth account, returns user object |

### `actions/vault.ts` (841 lines)

| Action | Parameters | Tables | Description |
|--------|-----------|--------|-------------|
| `getPackage` | `tagId` | `packages` | Single package by tag ID |
| `getFilteredPackages` | `filters` (batch, strain, type, activeOnly) | `packages` | Filtered package list |
| `getAllPackages` | `options` | `packages` | All packages |
| `getUniqueBatches` | - | `batches` | Active batch names |
| `getRecentTransactions` | `tagId, limit` | `transactions` | Weight change history |
| `getStrains` | - | `strains` | All strains |
| `getProductTypes` | - | `product_types` | All product types |
| `getBatches` | - | `batches` | All batches (with is_active filter) |
| `toggleBatchActive` | `batchId, isActive` | `batches` | Toggle batch visibility |
| `adjustWeight` | `tagId, amount` | `packages`, `transactions` | Change weight + create audit record |
| `createPackage` | `data` | `packages` | Create new package |
| `updatePackage` | `tagId, data` | `packages` | Update package fields |
| `deletePackage` | `tagId` | `packages` | Delete package |

### `actions/packaging.ts` (440 lines)

| Action | Parameters | Tables | Description |
|--------|-----------|--------|-------------|
| `getInventoryLevels` | - | `inventory` | Current cased/filled/staged per SKU |
| `getPackagingTasks` | - | `packaging_task_state` | All task state records |
| `getConfirmedOrders` | - | `orders`, `order_items` | Orders for packaging (confirmed status) |
| `advanceTask` | `taskId, sku, quantity, fromColumn` | `packaging_task_state`, `inventory` | Move task forward on Kanban |
| `revertTask` | `taskId, sku, quantity, fromColumn` | `packaging_task_state`, `inventory` | Undo task advance |
| `addContainer` | `sku, size` | `inventory` | Add staged container |
| `updateInventory` | `sku, cased, filled, staged` | `inventory` | Manual inventory adjustment |
| `updateTaskNote` | `taskKey, note` | `packaging_task_state` | Persist task notes |
| `saveTaskState` | `state` | `packaging_task_state` | Bulk save task positions |

### `actions/packaging-v2.ts` (477 lines, WIP)

| Action | Parameters | Tables | Description |
|--------|-----------|--------|-------------|
| `getDashboardData` | - | `inventory`, `packaging_task_state`, `orders` | Full dashboard state in one call |
| Material deduction logic | - | `material_transactions` | **COMMENTED OUT** -- not active |

### `actions/materials.ts` (827 lines)

| Action | Parameters | Tables | Description |
|--------|-----------|--------|-------------|
| `getMaterials` | - | `materials` | All materials |
| `getMaterial` | `id` | `materials` | Single material |
| `createMaterial` | `data` | `materials` | Create material |
| `updateMaterial` | `id, data` | `materials` | Update material |
| `deleteMaterial` | `id` | `materials` | Delete material |
| `getMaterialTransactions` | `materialId` | `material_transactions` | Stock change history |
| `recordMaterialTransaction` | `data` | `material_transactions`, `materials` | Log stock change, update current_stock |
| `getSkuMaterials` | `skuId` | `sku_materials` | Materials required for SKU |
| `linkMaterialToSku` | `skuId, materialId, quantityPerUnit` | `sku_materials` | Assign material to SKU |
| `updateSkuMaterial` | `id, quantityPerUnit` | `sku_materials` | Update quantity per unit |
| `unlinkMaterialFromSku` | `id` | `sku_materials` | Remove material from SKU |

### `actions/contacts.ts` (281 lines)

| Action | Parameters | Tables | Description |
|--------|-----------|--------|-------------|
| `getContacts` | `customerId` | `contacts` | Contacts for a dispensary |
| `createContact` | `data` | `contacts` | New contact |
| `updateContact` | `id, data` | `contacts` | Update contact |
| `deleteContact` | `id` | `contacts` | Delete contact |

---

## 6. Component Library

### shadcn/ui Components Installed (`components/ui/`)

40+ components from the shadcn/ui collection (Radix UI primitives + Tailwind):

**Form Controls:** `input`, `select`, `checkbox`, `switch`, `textarea`, `label`, `radio-group`, `slider`
**Layout Containers:** `card`, `dialog`, `sheet`, `popover`, `tabs`, `collapsible`, `separator`, `scroll-area`
**Navigation:** `sidebar`, `dropdown-menu`, `breadcrumb`, `navigation-menu`, `menubar`
**Feedback:** `alert-dialog`, `badge`, `tooltip`, `sonner` (toasts), `progress`, `skeleton`
**Data Display:** `table`, `avatar`, `calendar`, `aspect-ratio`
**Utilities:** `command` (cmdk searchable palette), `toggle`, `toggle-group`, `context-menu`

### Custom Components

| Component | Path | Purpose |
|-----------|------|---------|
| `floating-menu` | `components/ui/floating-menu.tsx` | FAB (floating action button) menu used in packaging |
| `date-preset-filter` | `components/filters/date-preset-filter.tsx` | Shared list date filter (presets + custom range) |
| `theme-provider` | `components/theme-provider.tsx` | next-themes setup |
| `theme-toggle` | `components/theme-toggle.tsx` | Dark/light mode toggle |
| `database-test` | `components/debug/database-test.tsx` | Debug utility for DB connection testing |

### Feature Components

| Component | Path | Purpose |
|-----------|------|---------|
| `order-sheet` | `components/orders/order-sheet.tsx` | Order create/edit form with case-based input |
| `contact-sheet` | `components/dispensaries/contact-sheet.tsx` | Contact create/edit form |
| `dispensary-contacts` | `components/dispensaries/dispensary-contacts.tsx` | Contact list for a dispensary |
| `edit-dispensary-sheet` | `components/dispensary/edit-dispensary-sheet.tsx` | Dispensary edit form |
| `customer-pricing` | `components/dispensary/customer-pricing.tsx` | Customer-specific pricing management |
| `product-sheet` | `components/products/product-sheet.tsx` | Product/SKU edit form |
| `sku-materials` | `components/products/sku-materials.tsx` | Link materials to SKU |
| `communication-sheet` | `components/communications/communication-sheet.tsx` | Communication log entry form |

---

## 7. Known Issues & Technical Debt

### Active Issues

| # | Issue | Location | Impact | Fix |
|---|-------|----------|--------|-----|
| 1 | Materials integration commented out | `actions/packaging-v2.ts` | Materials tracked but not auto-deducted on packaging task completion | Wire `recordMaterialTransaction()` into task advance flow |
| 2 | Legacy packaging components | `components/packaging/TaskQueue.tsx`, `TaskRow.tsx`, `RefreshControls.tsx` | Dead code, confusing | Delete the files |
| 3 | Zero test coverage | Entire codebase | No automated testing, regression risk | Write tests (Vitest configured) |
| 4 | Build errors ignored | `next.config.ts` | TS/ESLint errors don't block deploys | Consider enabling once codebase stabilizes |
| 5 | No `.env.example` | Project root | New developers must manually find env vars | Create `.env.example` |
| 6 | Old Supabase project active | `jwsidjgsjohhrntxdljp` | Confusion, potential cost | Archive/delete old project |
| 7 | Monorepo not implemented | Separate repos for packaging TV + cake-app | Code duplication | Phase 4 goal |
| 8 | Sales "Assigned Accounts" dashboard | `/dashboard/users` | Sales can't see their assigned dispensaries in profile | Build assigned accounts section |
| 9 | Commission system untested at scale | `commissions`, `commission_rates` | Edge cases with price tier logic | Production testing needed |
| 10 | Production URL undocumented | N/A | No record of deployed URL | Document in CLAUDE.md |
| 11 | No Vitest config file | Project root | `npm test` runs but no `vitest.config.ts` exists | Create config file |

### Commented-Out Code

**Primary location:** `actions/packaging-v2.ts` (~line 400)
```
// DISABLED: Materials imports - re-enable when materials module is complete
```

Rest of codebase is relatively clean of commented-out code.

### Hardcoded Values to Watch

| Value | Location | Current | Notes |
|-------|----------|---------|-------|
| `REFRESH_INTERVAL` | `app/dashboard/packaging/page.tsx` | 150000ms (2.5 min) | Packaging auto-refresh |
| `PAGE_SIZE` | `app/dashboard/dispensaries/page.tsx` | 50 | Dispensary list pagination |
| `BACKFILL_TARGET` | `lib/packaging/allocation-engine.ts` | 8 | Target stock level for backfill tasks |
| `SKU_LIST` | `types/packaging.ts` | 14 SKUs hardcoded | Should come from DB |

### Missing Error Handling

- Some components lack error state display for failed DB queries
- Database errors logged to console but not always shown as toasts
- Network failures during packaging auto-refresh not gracefully handled

---

## 8. Configuration Reference

### Environment Variables

| Variable | Required | Public | Description |
|----------|:--------:|:------:|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Yes | `https://spkimmrtaxwnysjqkxix.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Yes | Supabase anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | No | Server-only elevated access key |
| `DATA_SOURCE` | No | No | Set to `supabase` (legacy toggle) |

No `.env.example` exists. Keys must be copied from the Supabase vault project dashboard.

### next.config.ts Key Settings

```typescript
{
  eslint: { ignoreDuringBuilds: true },    // ESLint errors don't block build
  typescript: { ignoreBuildErrors: true },  // TS errors don't block build
  // + Serwist PWA wrapper (withSerwist)
}
```

### Middleware (`middleware.ts`)

- Refreshes Supabase session on every request
- Matches all routes except static files (`_next/static`, `_next/image`, favicon, images)
- Calls `updateSession()` from `lib/supabase/middleware.ts`

### PWA Configuration

**Service Worker** (`app/sw.ts`):
- Serwist 9.5.3
- Precaching with `defaultCache`
- Network-first strategy
- `skipWaiting` + `clientsClaim` enabled
- Offline fallback: `/~offline`

**Manifest** (`app/manifest.json`):
- Display: `standalone`
- Theme color: `#18181b` (zinc-950)
- Icons: 192x192 and 512x512 in `public/icons/`

### TypeScript Configuration

- Target: ES2017
- Strict mode: true (but not enforced in builds)
- Path alias: `@/*` maps to project root
- Includes `webworker` types for service worker

---

## 9. Quick Reference

### Common Commands

```bash
npm run dev          # Dev server (localhost:3000, Turbopack)
npm run build        # Production build (Turbopack)
npm run start        # Start production server
npm run lint         # ESLint
npm run type-check   # tsc --noEmit
npm test             # Vitest (no tests exist yet)
vercel --prod        # Deploy to production
```

### 20 Most Important Files

```
lib/auth-context.tsx                    # Auth provider, permissions, useAuth()
lib/supabase/server.ts                  # Server + service Supabase clients
lib/supabase/client.ts                  # Browser Supabase client
lib/packaging/allocation-engine.ts      # Task generation from orders
lib/packaging/db.ts                     # Packaging data layer (19.7KB)
lib/packaging/types.ts                  # SKU list, packaging types
actions/vault.ts                        # Vault CRUD (841 lines)
actions/packaging.ts                    # Packaging task management (440 lines)
actions/materials.ts                    # Materials CRUD (827 lines)
actions/contacts.ts                     # Contact CRUD (281 lines)
actions/auth.ts                         # PIN authentication
types/database.ts                       # Supabase-generated DB types
types/vault.ts                          # Vault types
app/dashboard/layout.tsx                # Role-based nav, sidebar
app/dashboard/packaging/page.tsx        # Kanban board
app/dashboard/orders/page.tsx           # Order management
app/dashboard/vault/page.tsx            # Vault package browser
components/orders/order-sheet.tsx       # Order create/edit form
middleware.ts                           # Supabase session refresh
next.config.ts                          # Build config + PWA
```

### Database Tables (Alphabetical)

```
batches              commission_rates    commissions         communications
contacts             customer_pricing    customers           inventory
material_transactions materials          order_items         orders
packages             packaging_task_state product_pricing    product_types
products (VIEW)      profiles (VIEW)     sales_tasks         sku_materials
sku_pricing          skus                strains             transactions
users
```

### Supabase Client Patterns

```typescript
// Browser component (client-side)
import { createClient } from '@/lib/supabase/client'
const supabase = createClient()

// Server Action or Server Component
import { createClient } from '@/lib/supabase/server'
const supabase = await createClient()

// Elevated privileges (bypass RLS)
import { createServiceClient } from '@/lib/supabase/server'
const supabase = await createServiceClient()
```

### Order Status Flow

```
pending -> confirmed -> packed -> delivered
                    \-> cancelled
```

Triggers on status change:
- `packed`: deducts from CASED inventory (checks `packed_at` to prevent double deduction)
- `delivered`: deducts from CASED + creates commission record via `create_commission_on_delivery()` trigger
- Revert to `pending`: restores CASED amounts

### Commission Rate Resolution

```
1. Check for SKU-specific rate for this salesperson
2. Check for product_type rate for this salesperson
3. Check for salesperson default rate
4. Check for global default rate
(Each filtered by effective_from/effective_to date range)
(Price tier override via min_unit_price if applicable)
```
