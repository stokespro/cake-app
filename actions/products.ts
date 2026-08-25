'use server'

import { requireRole } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import type { Product, ProductType } from '@/types/database'

// Roles that can read products (matches canViewSection 'products')
const PRODUCTS_READ_ROLES = ['admin', 'management', 'vault', 'packaging', 'standard']
// Roles that can create/edit products
const PRODUCTS_WRITE_ROLES = ['admin', 'management']

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getProducts(): Promise<
  { data: Product[]; error?: never } | { data?: never; error: string }
> {
  const auth = await requireRole(PRODUCTS_READ_ROLES)
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const { data, error } = await db
    .from('products')
    .select('*')
    .order('item_name')

  if (error) {
    console.error('[products] getProducts error:', error)
    return { error: error.message }
  }

  return { data: data || [] }
}

export async function getProductTypes(): Promise<
  { data: ProductType[]; error?: never } | { data?: never; error: string }
> {
  const auth = await requireRole(PRODUCTS_READ_ROLES)
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const { data, error } = await db
    .from('product_types')
    .select('*')
    .order('name')

  if (error) {
    console.error('[products] getProductTypes error:', error)
    return { error: error.message }
  }

  return { data: data || [] }
}

export async function getStrains(): Promise<
  { data: { id: string; name: string }[]; error?: never } | { data?: never; error: string }
> {
  const auth = await requireRole(PRODUCTS_READ_ROLES)
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const { data, error } = await db
    .from('strains')
    .select('id, name')
    .order('name')

  if (error) {
    console.error('[products] getStrains error:', error)
    return { error: error.message }
  }

  return { data: data || [] }
}

// ---------------------------------------------------------------------------
// SKU code uniqueness check (used in product-sheet validation)
// ---------------------------------------------------------------------------

export async function checkSkuCodeExists(
  code: string,
  excludeId?: string
): Promise<{ exists: boolean; error?: string }> {
  const auth = await requireRole(PRODUCTS_WRITE_ROLES)
  if (!auth.authorized) return { exists: false, error: auth.reason }

  const db = await createServiceClient()

  let query = db
    .from('skus')
    .select('id, code')
    .eq('code', code.trim().toUpperCase())

  if (excludeId) {
    query = query.neq('id', excludeId)
  }

  const { data, error } = await query

  if (error) {
    console.error('[products] checkSkuCodeExists error:', error)
    return { exists: false, error: error.message }
  }

  return { exists: (data?.length ?? 0) > 0 }
}

// ---------------------------------------------------------------------------
// SKU name uniqueness check (used in product-sheet validation)
// ---------------------------------------------------------------------------

export async function checkSkuNameExists(
  name: string,
  excludeId?: string
): Promise<{ exists: boolean; error?: string }> {
  const auth = await requireRole(PRODUCTS_WRITE_ROLES)
  if (!auth.authorized) return { exists: false, error: auth.reason }

  const db = await createServiceClient()

  let query = db
    .from('skus')
    .select('id, name')
    .eq('name', name.trim())

  if (excludeId) {
    query = query.neq('id', excludeId)
  }

  const { data, error } = await query

  if (error) {
    console.error('[products] checkSkuNameExists error:', error)
    return { exists: false, error: error.message }
  }

  return { exists: (data?.length ?? 0) > 0 }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface CreateSkuInput {
  code: string
  name: string
  strain_id: string
  product_type_id: string
  units_per_case: number
  grams_per_unit: number
  status: 'active' | 'staged' | 'discontinued'
  description?: string | null
}

export async function createSku(input: CreateSkuInput): Promise<
  { error?: never } | { error: string }
> {
  const auth = await requireRole(PRODUCTS_WRITE_ROLES)
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const { data: created, error } = await db
    .from('skus')
    .insert({
      code: input.code.trim().toUpperCase(),
      name: input.name.trim(),
      strain_id: input.strain_id,
      product_type_id: input.product_type_id,
      units_per_case: input.units_per_case,
      grams_per_unit: input.grams_per_unit,
      status: input.status,
      description: input.description?.trim() || null,
    })
    .select('id')
    .single()

  if (error) {
    console.error('[products] createSku error:', error)
    if (error.code === '23505') {
      return { error: 'A product with this code or name already exists. Please choose different values.' }
    }
    return { error: `Failed to create product: ${error.message}` }
  }

  // SPRO-131: give every new SKU its inventory row up front. Creating a SKU
  // without one is what made Aloha Sugar unstageable — the packaging write
  // paths now upsert so they recover on their own, but a SKU that starts life
  // with a real row is the actual invariant, and it keeps every read path
  // (inventory dashboard, order availability, in_stock derivation) honest from
  // the first day rather than from the first time someone stages it.
  //
  // ignoreDuplicates so this stays correct once the DB-level trigger in
  // 20260825170000_backfill_inventory_rows.sql is applied.
  const { error: inventoryError } = await db
    .from('inventory')
    .upsert(
      { sku_id: created.id, cased: 0, filled: 0, staged: 0 },
      { onConflict: 'sku_id', ignoreDuplicates: true }
    )

  if (inventoryError) {
    // The SKU exists and the packaging write paths upsert, so this is
    // recoverable — surface it rather than failing the whole creation.
    console.error('[products] createSku inventory row error:', inventoryError)
  }

  return {}
}

export interface UpdateSkuInput {
  name: string
  description?: string | null
  product_type_id: string
  units_per_case: number
  grams_per_unit: number
  status: 'active' | 'staged' | 'discontinued'
}

export async function updateSku(id: string, input: UpdateSkuInput): Promise<
  { error?: never } | { error: string }
> {
  const auth = await requireRole(PRODUCTS_WRITE_ROLES)
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const { error } = await db
    .from('skus')
    .update({
      name: input.name.trim(),
      description: input.description?.trim() || null,
      product_type_id: input.product_type_id,
      units_per_case: input.units_per_case,
      grams_per_unit: input.grams_per_unit,
      status: input.status,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)

  if (error) {
    console.error('[products] updateSku error:', error)
    if (error.code === '23505') {
      return { error: 'A product with this name already exists. Please choose a different name.' }
    }
    return { error: `Failed to update product: ${error.message}` }
  }

  return {}
}
