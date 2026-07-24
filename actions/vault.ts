'use server'

import { requireRole } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import type { VaultPackage, Transaction, PackageFilters, ProductType, Strain, Batch } from '@/types/vault'

// Roles that can read vault data (matches canViewSection 'vault')
const VAULT_READ_ROLES = ['admin', 'management', 'vault', 'standard']
// Roles that can mutate packages (vault workers + management)
const VAULT_WRITE_ROLES = ['admin', 'management', 'vault']
// Roles that can access admin functions (strains/batches/product types)
const VAULT_ADMIN_ROLES = ['admin', 'management']
// Roles that can read inventory (broader — matches canViewSection 'inventory')
const INVENTORY_READ_ROLES = ['admin', 'management', 'vault', 'packaging', 'standard', 'sales', 'agent']

// Get a single package by tag ID
export async function getPackage(tagId: string): Promise<{
  success: boolean
  package?: VaultPackage | null
  error?: string
}> {
  const auth = await requireRole(VAULT_READ_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  const db = await createServiceClient()

  const { data, error } = await db
    .from('packages')
    .select(`
      *,
      type:product_types(*),
      strain_info:strains(*),
      creator:users(id, name)
    `)
    .eq('tag_id', tagId)
    .single()

  if (error) {
    if (error.code === 'PGRST116') {
      // No rows returned
      return { success: true, package: null }
    }
    return { success: false, error: error.message }
  }

  return { success: true, package: data as VaultPackage }
}

// Get filtered packages
export async function getFilteredPackages(filters: PackageFilters & { activeOnly?: boolean }): Promise<{
  success: boolean
  packages?: VaultPackage[]
  error?: string
}> {
  const auth = await requireRole(VAULT_READ_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  const db = await createServiceClient()

  let query = db
    .from('packages')
    .select(`
      *,
      type:product_types(*),
      strain_info:strains(*),
      creator:users(id, name)
    `)

  if (filters.batches && filters.batches.length > 0) {
    query = query.in('batch', filters.batches)
  }

  if (filters.strainIds && filters.strainIds.length > 0) {
    query = query.in('strain_id', filters.strainIds)
  }

  if (filters.typeIds && filters.typeIds.length > 0) {
    query = query.in('type_id', filters.typeIds)
  }

  // Filter by active status if requested (default to true for backwards compatibility)
  if (filters.activeOnly !== false) {
    query = query.eq('is_active', true)
  }

  const { data, error } = await query.order('batch', { ascending: true })

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true, packages: data as VaultPackage[] }
}

// Get all packages (for summary view)
export async function getAllPackages(options?: { activeOnly?: boolean }): Promise<{
  success: boolean
  packages?: VaultPackage[]
  error?: string
}> {
  const auth = await requireRole(VAULT_READ_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  const db = await createServiceClient()

  let query = db
    .from('packages')
    .select(`
      *,
      type:product_types(*),
      strain_info:strains(*)
    `)

  // Filter by active status if requested (default to true for backwards compatibility)
  if (options?.activeOnly !== false) {
    query = query.eq('is_active', true)
  }

  const { data, error } = await query.order('strain', { ascending: true })

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true, packages: data as VaultPackage[] }
}

// Get packages for inventory page (broader role set)
export async function getPackagesForInventory(): Promise<{
  success: boolean
  packages?: Pick<VaultPackage, 'strain_id' | 'type_id' | 'current_weight' | 'is_active'>[]
  error?: string
}> {
  const auth = await requireRole(INVENTORY_READ_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  const db = await createServiceClient()

  const { data, error } = await db
    .from('packages')
    .select('strain_id, type_id, current_weight, is_active')
    .eq('is_active', true)

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true, packages: data }
}

// Get unique batches for filtering (only active batches)
export async function getUniqueBatches(): Promise<{
  success: boolean
  batches?: string[]
  error?: string
}> {
  const auth = await requireRole(VAULT_READ_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  const db = await createServiceClient()

  // Get all active batch names
  const { data: activeBatches, error: batchError } = await db
    .from('batches')
    .select('name')
    .eq('is_active', true)

  if (batchError) {
    return { success: false, error: batchError.message }
  }

  const activeBatchNames = new Set(activeBatches.map(b => b.name))

  // Get unique batches from packages, filtered to only active ones
  const { data, error } = await db
    .from('packages')
    .select('batch')
    .order('batch', { ascending: true })

  if (error) {
    return { success: false, error: error.message }
  }

  const uniqueBatches = [...new Set(data.map(p => p.batch))].filter(batch => activeBatchNames.has(batch))
  return { success: true, batches: uniqueBatches }
}

// Get recent transactions for a package
export async function getRecentTransactions(tagId: string, limit: number = 10): Promise<{
  success: boolean
  transactions?: Transaction[]
  error?: string
}> {
  const auth = await requireRole(VAULT_READ_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  const db = await createServiceClient()

  const { data, error } = await db
    .from('transactions')
    .select(`
      *,
      user:users(id, name)
    `)
    .eq('tag_id', tagId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true, transactions: data as Transaction[] }
}

// Adjust weight on a package
export async function adjustWeight(
  tagId: string,
  amount: number,
  type: 'add' | 'remove',
  userId: string
): Promise<{ success: boolean; package?: VaultPackage; error?: string }> {
  const auth = await requireRole(VAULT_WRITE_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  const db = await createServiceClient()

  if (amount <= 0) {
    return { success: false, error: 'Amount must be greater than 0' }
  }

  // Get current package
  const { data: currentPackage, error: fetchError } = await db
    .from('packages')
    .select('current_weight')
    .eq('tag_id', tagId)
    .single()

  if (fetchError || !currentPackage) {
    return { success: false, error: 'Package not found' }
  }

  const currentWeight = Number(currentPackage.current_weight)
  let newBalance: number

  if (type === 'add') {
    newBalance = currentWeight + amount
  } else {
    if (currentWeight < amount) {
      return { success: false, error: 'Insufficient balance' }
    }
    newBalance = currentWeight - amount
  }

  // Round to 2 decimal places
  newBalance = Math.round(newBalance * 100) / 100

  // Update package
  const { error: updateError } = await db
    .from('packages')
    .update({ current_weight: newBalance })
    .eq('tag_id', tagId)

  if (updateError) {
    return { success: false, error: updateError.message }
  }

  // Log transaction
  await db
    .from('transactions')
    .insert({
      tag_id: tagId,
      user_id: userId,
      type,
      amount,
      resulting_balance: newBalance,
    })

  // Fetch updated package with joins
  const { data: updatedPackage, error: refetchError } = await db
    .from('packages')
    .select(`
      *,
      type:product_types(*),
      strain_info:strains(*),
      creator:users(id, name)
    `)
    .eq('tag_id', tagId)
    .single()

  if (refetchError) {
    return { success: false, error: refetchError.message }
  }

  return { success: true, package: updatedPackage as VaultPackage }
}

// Create a new package
export async function createPackage(
  tagId: string,
  batch: string,
  strain: string,
  strainId: string,
  typeId: string,
  startingWeight: number,
  userId: string
): Promise<{ success: boolean; package?: VaultPackage; error?: string }> {
  const auth = await requireRole(VAULT_WRITE_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  const db = await createServiceClient()

  if (!tagId.trim()) {
    return { success: false, error: 'Tag ID is required' }
  }

  if (!batch.trim()) {
    return { success: false, error: 'Batch is required' }
  }

  if (!strainId) {
    return { success: false, error: 'Strain is required' }
  }

  if (!typeId) {
    return { success: false, error: 'Type is required' }
  }

  if (startingWeight < 0) {
    return { success: false, error: 'Starting weight must be positive' }
  }

  // Check if tag already exists
  const { data: existing } = await db
    .from('packages')
    .select('tag_id')
    .eq('tag_id', tagId.trim())
    .single()

  if (existing) {
    return { success: false, error: 'Tag ID already exists' }
  }

  // Create the package
  const { data: packageData, error: packageError } = await db
    .from('packages')
    .insert({
      tag_id: tagId.trim(),
      batch: batch.trim(),
      strain: strain.trim(),
      strain_id: strainId,
      type_id: typeId,
      current_weight: startingWeight,
      created_by: userId,
    })
    .select(`
      *,
      type:product_types(*),
      strain_info:strains(*),
      creator:users(id, name)
    `)
    .single()

  if (packageError) {
    return { success: false, error: packageError.message }
  }

  // Log the initial transaction
  await db
    .from('transactions')
    .insert({
      tag_id: tagId.trim(),
      user_id: userId,
      type: 'add',
      amount: startingWeight,
      resulting_balance: startingWeight,
    })

  return { success: true, package: packageData as VaultPackage }
}

// Toggle package active status
export async function togglePackageActive(
  tagId: string,
  isActive: boolean
): Promise<{ success: boolean; package?: VaultPackage; error?: string }> {
  const auth = await requireRole(VAULT_ADMIN_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  const db = await createServiceClient()

  const { data, error } = await db
    .from('packages')
    .update({ is_active: isActive, updated_at: new Date().toISOString() })
    .eq('tag_id', tagId)
    .select(`
      *,
      type:product_types(*),
      strain_info:strains(*),
      creator:users(id, name)
    `)
    .single()

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true, package: data as VaultPackage }
}

// Update an existing package
export async function updatePackage(
  tagId: string,
  updates: {
    batch?: string
    strain?: string
    strainId?: string
    typeId?: string
  }
): Promise<{ success: boolean; package?: VaultPackage; error?: string }> {
  const auth = await requireRole(VAULT_ADMIN_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  const db = await createServiceClient()

  const updateData: Record<string, unknown> = {}

  if (updates.batch !== undefined) {
    if (!updates.batch.trim()) {
      return { success: false, error: 'Batch cannot be empty' }
    }
    updateData.batch = updates.batch.trim()
  }

  if (updates.strain !== undefined) {
    updateData.strain = updates.strain.trim()
  }

  if (updates.strainId !== undefined) {
    if (!updates.strainId) {
      return { success: false, error: 'Strain is required' }
    }
    updateData.strain_id = updates.strainId
  }

  if (updates.typeId !== undefined) {
    if (!updates.typeId) {
      return { success: false, error: 'Type is required' }
    }
    updateData.type_id = updates.typeId
  }

  if (Object.keys(updateData).length === 0) {
    return { success: false, error: 'No updates provided' }
  }

  updateData.updated_at = new Date().toISOString()

  const { error: updateError } = await db
    .from('packages')
    .update(updateData)
    .eq('tag_id', tagId)

  if (updateError) {
    return { success: false, error: updateError.message }
  }

  // Fetch updated package with joins
  const { data: updatedPackage, error: refetchError } = await db
    .from('packages')
    .select(`
      *,
      type:product_types(*),
      strain_info:strains(*),
      creator:users(id, name)
    `)
    .eq('tag_id', tagId)
    .single()

  if (refetchError) {
    return { success: false, error: refetchError.message }
  }

  return { success: true, package: updatedPackage as VaultPackage }
}

// Get all strains
export async function getStrains(): Promise<{
  success: boolean
  strains?: Strain[]
  error?: string
}> {
  const auth = await requireRole(VAULT_READ_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  const db = await createServiceClient()

  const { data, error } = await db
    .from('strains')
    .select('*')
    .order('name', { ascending: true })

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true, strains: data as Strain[] }
}

// Get all product types
export async function getProductTypes(): Promise<{
  success: boolean
  productTypes?: ProductType[]
  error?: string
}> {
  const auth = await requireRole(VAULT_READ_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  const db = await createServiceClient()

  const { data, error } = await db
    .from('product_types')
    .select('*')
    .order('name', { ascending: true })

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true, productTypes: data as ProductType[] }
}

// ============================================================================
// STRAIN CRUD OPERATIONS
// ============================================================================

export async function createStrain(
  name: string
): Promise<{ success: boolean; strain?: Strain; error?: string }> {
  const auth = await requireRole(VAULT_ADMIN_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  const db = await createServiceClient()

  if (!name.trim()) {
    return { success: false, error: 'Name is required' }
  }

  // Check if name already exists
  const { data: existing } = await db
    .from('strains')
    .select('id')
    .ilike('name', name.trim())
    .single()

  if (existing) {
    return { success: false, error: 'Strain already exists' }
  }

  const { data, error } = await db
    .from('strains')
    .insert({ name: name.trim() })
    .select()
    .single()

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true, strain: data as Strain }
}

export async function updateStrain(
  id: string,
  name: string
): Promise<{ success: boolean; strain?: Strain; error?: string }> {
  const auth = await requireRole(VAULT_ADMIN_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  const db = await createServiceClient()

  if (!name.trim()) {
    return { success: false, error: 'Name is required' }
  }

  // Check if name already exists for another strain
  const { data: existing } = await db
    .from('strains')
    .select('id')
    .ilike('name', name.trim())
    .neq('id', id)
    .single()

  if (existing) {
    return { success: false, error: 'Strain already exists' }
  }

  const { data, error } = await db
    .from('strains')
    .update({ name: name.trim() })
    .eq('id', id)
    .select()
    .single()

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true, strain: data as Strain }
}

export async function deleteStrain(id: string): Promise<{ success: boolean; error?: string }> {
  const auth = await requireRole(VAULT_ADMIN_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  const db = await createServiceClient()

  // Check if any packages use this strain
  const { data: packages } = await db
    .from('packages')
    .select('tag_id')
    .eq('strain_id', id)
    .limit(1)

  if (packages && packages.length > 0) {
    return { success: false, error: 'Cannot delete strain that is in use by packages' }
  }

  const { error } = await db
    .from('strains')
    .delete()
    .eq('id', id)

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true }
}

// ============================================================================
// BATCH CRUD OPERATIONS
// ============================================================================

export async function getBatches(options?: { activeOnly?: boolean }): Promise<{
  success: boolean
  batches?: Batch[]
  error?: string
}> {
  const auth = await requireRole(VAULT_READ_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  const db = await createServiceClient()

  let query = db
    .from('batches')
    .select(`
      *,
      strain:strains(*)
    `)

  // Filter by active status if requested
  if (options?.activeOnly) {
    query = query.eq('is_active', true)
  }

  const { data, error } = await query.order('name', { ascending: true })

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true, batches: data as Batch[] }
}

// Toggle batch active status
export async function toggleBatchActive(
  id: string,
  isActive: boolean
): Promise<{ success: boolean; batch?: Batch; error?: string }> {
  const auth = await requireRole(VAULT_ADMIN_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  const db = await createServiceClient()

  const { data, error } = await db
    .from('batches')
    .update({ is_active: isActive })
    .eq('id', id)
    .select(`
      *,
      strain:strains(*)
    `)
    .single()

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true, batch: data as Batch }
}

// Bulk toggle active status for a set of batches in a single query
export async function bulkToggleBatchActive(
  ids: string[],
  isActive: boolean
): Promise<{ success: boolean; updatedCount?: number; error?: string }> {
  const auth = await requireRole(VAULT_ADMIN_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  if (!ids || ids.length === 0) {
    return { success: false, error: 'No batches selected' }
  }

  const db = await createServiceClient()

  const { data, error } = await db
    .from('batches')
    .update({ is_active: isActive })
    .in('id', ids)
    .select('id')

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true, updatedCount: data?.length ?? 0 }
}

// Optional lab/COA testing values captured on a batch
export interface BatchTestingFields {
  thcPercentage?: number | string | null
  terpenesPercentage?: number | string | null
  totalCannabinoidsPercentage?: number | string | null
}

// Normalizes an optional percentage input (number, numeric string, or empty/null)
// into a number in [0, 100] or null. Throws a plain Error with a friendly message
// when the value is present but invalid.
function parsePercentage(value: number | string | null | undefined, label: string): number | null {
  if (value === null || value === undefined || value === '') {
    return null
  }

  const parsed = typeof value === 'number' ? value : Number(value)

  if (Number.isNaN(parsed)) {
    throw new Error(`${label} must be a number`)
  }

  if (parsed < 0 || parsed > 100) {
    throw new Error(`${label} must be between 0 and 100`)
  }

  return parsed
}

export async function createBatch(
  name: string,
  strainId: string,
  testing?: BatchTestingFields
): Promise<{ success: boolean; batch?: Batch; error?: string }> {
  const auth = await requireRole(VAULT_ADMIN_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  const db = await createServiceClient()

  if (!name.trim()) {
    return { success: false, error: 'Batch name is required' }
  }

  if (!strainId) {
    return { success: false, error: 'Strain is required' }
  }

  let thcPercentage: number | null
  let terpenesPercentage: number | null
  let totalCannabinoidsPercentage: number | null
  try {
    thcPercentage = parsePercentage(testing?.thcPercentage, 'THC %')
    terpenesPercentage = parsePercentage(testing?.terpenesPercentage, 'Terpenes %')
    totalCannabinoidsPercentage = parsePercentage(testing?.totalCannabinoidsPercentage, 'Total Cannabinoids %')
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Invalid testing values' }
  }

  // Check if batch already exists
  const { data: existing } = await db
    .from('batches')
    .select('id')
    .ilike('name', name.trim())
    .single()

  if (existing) {
    return { success: false, error: 'Batch already exists' }
  }

  const { data, error } = await db
    .from('batches')
    .insert({
      name: name.trim(),
      strain_id: strainId,
      thc_percentage: thcPercentage,
      terpenes_percentage: terpenesPercentage,
      total_cannabinoids_percentage: totalCannabinoidsPercentage,
    })
    .select(`
      *,
      strain:strains(*)
    `)
    .single()

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true, batch: data as Batch }
}

export async function updateBatch(
  id: string,
  name: string,
  strainId: string,
  testing?: BatchTestingFields
): Promise<{ success: boolean; batch?: Batch; error?: string }> {
  const auth = await requireRole(VAULT_ADMIN_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  const db = await createServiceClient()

  if (!name.trim()) {
    return { success: false, error: 'Batch name is required' }
  }

  if (!strainId) {
    return { success: false, error: 'Strain is required' }
  }

  let thcPercentage: number | null
  let terpenesPercentage: number | null
  let totalCannabinoidsPercentage: number | null
  try {
    thcPercentage = parsePercentage(testing?.thcPercentage, 'THC %')
    terpenesPercentage = parsePercentage(testing?.terpenesPercentage, 'Terpenes %')
    totalCannabinoidsPercentage = parsePercentage(testing?.totalCannabinoidsPercentage, 'Total Cannabinoids %')
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Invalid testing values' }
  }

  // Check if another batch with this name exists
  const { data: existing } = await db
    .from('batches')
    .select('id')
    .ilike('name', name.trim())
    .neq('id', id)
    .single()

  if (existing) {
    return { success: false, error: 'Another batch with this name already exists' }
  }

  const { data, error } = await db
    .from('batches')
    .update({
      name: name.trim(),
      strain_id: strainId,
      thc_percentage: thcPercentage,
      terpenes_percentage: terpenesPercentage,
      total_cannabinoids_percentage: totalCannabinoidsPercentage,
    })
    .eq('id', id)
    .select(`
      *,
      strain:strains(*)
    `)
    .single()

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true, batch: data as Batch }
}

export async function deleteBatch(id: string): Promise<{ success: boolean; error?: string }> {
  const auth = await requireRole(VAULT_ADMIN_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  const db = await createServiceClient()

  // First get the batch name to check packages
  const { data: batch } = await db
    .from('batches')
    .select('name')
    .eq('id', id)
    .single()

  if (!batch) {
    return { success: false, error: 'Batch not found' }
  }

  // Check if any packages use this batch (by name, since packages.batch is a text field)
  const { data: packages } = await db
    .from('packages')
    .select('tag_id')
    .eq('batch', batch.name)
    .limit(1)

  if (packages && packages.length > 0) {
    return { success: false, error: 'Cannot delete batch that is in use by packages' }
  }

  const { error } = await db
    .from('batches')
    .delete()
    .eq('id', id)

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true }
}

// Get active batches (with lab-testing fields) for a given strain — used by
// the inventory page to show COA/test results when a user drills into a card.
export async function getActiveBatchesForStrain(strainId: string): Promise<{
  success: boolean
  batches?: Batch[]
  error?: string
}> {
  const auth = await requireRole(INVENTORY_READ_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  if (!strainId) {
    return { success: false, error: 'Strain is required' }
  }

  const db = await createServiceClient()

  const { data, error } = await db
    .from('batches')
    .select(`
      *,
      strain:strains(*)
    `)
    .eq('strain_id', strainId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true, batches: data as Batch[] }
}

// ============================================================================
// PRODUCT TYPE CRUD OPERATIONS
// ============================================================================

export async function createProductType(
  name: string
): Promise<{ success: boolean; productType?: ProductType; error?: string }> {
  const auth = await requireRole(VAULT_ADMIN_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  const db = await createServiceClient()

  if (!name.trim()) {
    return { success: false, error: 'Name is required' }
  }

  // Check if name already exists
  const { data: existing } = await db
    .from('product_types')
    .select('id')
    .ilike('name', name.trim())
    .single()

  if (existing) {
    return { success: false, error: 'Product type already exists' }
  }

  const { data, error } = await db
    .from('product_types')
    .insert({ name: name.trim() })
    .select()
    .single()

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true, productType: data as ProductType }
}

export async function updateProductType(
  id: string,
  name: string
): Promise<{ success: boolean; productType?: ProductType; error?: string }> {
  const auth = await requireRole(VAULT_ADMIN_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  const db = await createServiceClient()

  if (!name.trim()) {
    return { success: false, error: 'Name is required' }
  }

  // Check if name already exists for another type
  const { data: existing } = await db
    .from('product_types')
    .select('id')
    .ilike('name', name.trim())
    .neq('id', id)
    .single()

  if (existing) {
    return { success: false, error: 'Product type already exists' }
  }

  const { data, error } = await db
    .from('product_types')
    .update({ name: name.trim() })
    .eq('id', id)
    .select()
    .single()

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true, productType: data as ProductType }
}

export async function deleteProductType(id: string): Promise<{ success: boolean; error?: string }> {
  const auth = await requireRole(VAULT_ADMIN_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  const db = await createServiceClient()

  // Check if any packages use this type
  const { data: packages } = await db
    .from('packages')
    .select('tag_id')
    .eq('type_id', id)
    .limit(1)

  if (packages && packages.length > 0) {
    return { success: false, error: 'Cannot delete type that is in use by packages' }
  }

  const { error } = await db
    .from('product_types')
    .delete()
    .eq('id', id)

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true }
}
