'use server'

import { requireRole } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'

// Roles that can read materials (matches canViewSection 'materials' / 'packaging')
const MATERIALS_READ_ROLES = ['admin', 'management', 'packaging', 'trim_manager', 'standard', 'vault']
// Roles that can mutate materials (packaging workers + management)
const MATERIALS_WRITE_ROLES = ['admin', 'management', 'packaging', 'trim_manager']

// Types for materials
export interface Material {
  id: string
  name: string
  sku_code: string | null
  material_type: string
  current_stock: number
  low_stock_threshold: number
  created_at: string
  updated_at: string
}

export interface MaterialTransaction {
  id: string
  material_id: string
  quantity: number
  transaction_type: 'restock' | 'usage' | 'adjustment' | 'initial'
  sku_id: string | null
  user_id: string | null
  notes: string | null
  created_at: string
  material?: Material
  user?: { id: string; name: string }
}

export interface CreateMaterialInput {
  name: string
  sku_code?: string
  material_type: string
  initial_stock?: number
  low_stock_threshold?: number
}

export interface UpdateMaterialInput {
  name?: string
  sku_code?: string
  material_type?: string
  low_stock_threshold?: number
}

// Types for SKU-Material assignments
export interface SkuMaterial {
  id: string
  sku_id: string
  material_id: string
  quantity_per_unit: number
  created_at: string
  updated_at: string
  material?: Material
}

export interface SkuMaterialWithDetails extends SkuMaterial {
  material: Material
}

// ============================================
// GET MATERIALS
// ============================================

export async function getMaterials(): Promise<{
  success: boolean
  data?: Material[]
  error?: string
}> {
  const auth = await requireRole(MATERIALS_READ_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const db = await createServiceClient()

    const { data, error } = await db
      .from('materials')
      .select('*')
      .order('name')

    if (error) {
      console.error('Error fetching materials:', error)
      return { success: false, error: error.message }
    }

    return { success: true, data: data || [] }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

export async function getMaterial(id: string): Promise<{
  success: boolean
  data?: Material
  error?: string
}> {
  const auth = await requireRole(MATERIALS_READ_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const db = await createServiceClient()

    const { data, error } = await db
      .from('materials')
      .select('*')
      .eq('id', id)
      .single()

    if (error) {
      console.error('Error fetching material:', error)
      return { success: false, error: error.message }
    }

    return { success: true, data }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

// ============================================
// CREATE MATERIAL
// ============================================

export async function createMaterial(input: CreateMaterialInput): Promise<{
  success: boolean
  data?: Material
  error?: string
}> {
  const auth = await requireRole(MATERIALS_WRITE_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const db = await createServiceClient()

    // Check for duplicate name
    const { data: existing } = await db
      .from('materials')
      .select('id')
      .eq('name', input.name.trim())
      .maybeSingle()

    if (existing) {
      return { success: false, error: 'A material with this name already exists' }
    }

    const materialData = {
      name: input.name.trim(),
      sku_code: input.sku_code?.trim() || null,
      material_type: input.material_type,
      current_stock: input.initial_stock || 0,
      low_stock_threshold: input.low_stock_threshold || 10,
    }

    const { data, error } = await db
      .from('materials')
      .insert(materialData)
      .select()
      .single()

    if (error) {
      console.error('Error creating material:', error)
      return { success: false, error: error.message }
    }

    // Log initial stock transaction if there's initial stock
    if (input.initial_stock && input.initial_stock > 0) {
      await db.from('material_transactions').insert({
        material_id: data.id,
        quantity: input.initial_stock,
        transaction_type: 'initial',
        notes: 'Initial stock',
      })
    }

    return { success: true, data }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

// ============================================
// UPDATE MATERIAL
// ============================================

export async function updateMaterial(
  id: string,
  input: UpdateMaterialInput
): Promise<{
  success: boolean
  data?: Material
  error?: string
}> {
  const auth = await requireRole(MATERIALS_WRITE_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const db = await createServiceClient()

    // Check for duplicate name if name is being updated
    if (input.name) {
      const { data: existing } = await db
        .from('materials')
        .select('id')
        .eq('name', input.name.trim())
        .neq('id', id)
        .maybeSingle()

      if (existing) {
        return { success: false, error: 'A material with this name already exists' }
      }
    }

    const updateData: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    }

    if (input.name !== undefined) updateData.name = input.name.trim()
    if (input.sku_code !== undefined) updateData.sku_code = input.sku_code?.trim() || null
    if (input.material_type !== undefined) updateData.material_type = input.material_type
    if (input.low_stock_threshold !== undefined) updateData.low_stock_threshold = input.low_stock_threshold

    const { data, error } = await db
      .from('materials')
      .update(updateData)
      .eq('id', id)
      .select()
      .single()

    if (error) {
      console.error('Error updating material:', error)
      return { success: false, error: error.message }
    }

    return { success: true, data }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

// ============================================
// DELETE MATERIAL
// ============================================

export async function deleteMaterial(id: string): Promise<{
  success: boolean
  error?: string
}> {
  const auth = await requireRole(MATERIALS_WRITE_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const db = await createServiceClient()

    // Delete related transactions first
    await db
      .from('material_transactions')
      .delete()
      .eq('material_id', id)

    const { error } = await db
      .from('materials')
      .delete()
      .eq('id', id)

    if (error) {
      console.error('Error deleting material:', error)
      return { success: false, error: error.message }
    }

    return { success: true }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

// ============================================
// RESTOCK MATERIAL
// ============================================

export async function restockMaterial(
  id: string,
  quantity: number,
  notes?: string,
  userId?: string
): Promise<{
  success: boolean
  data?: Material
  error?: string
}> {
  const auth = await requireRole(MATERIALS_WRITE_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    if (quantity <= 0) {
      return { success: false, error: 'Quantity must be greater than 0' }
    }

    const db = await createServiceClient()

    // Get current material
    const { data: material, error: fetchError } = await db
      .from('materials')
      .select('*')
      .eq('id', id)
      .single()

    if (fetchError || !material) {
      return { success: false, error: 'Material not found' }
    }

    // Update stock
    const newStock = material.current_stock + quantity
    const { data, error: updateError } = await db
      .from('materials')
      .update({
        current_stock: newStock,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single()

    if (updateError) {
      console.error('Error restocking material:', updateError)
      return { success: false, error: updateError.message }
    }

    // Log transaction
    await db.from('material_transactions').insert({
      material_id: id,
      quantity: quantity,
      transaction_type: 'restock',
      user_id: userId || null,
      notes: notes?.trim() || null,
    })

    return { success: true, data }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

// ============================================
// USE MATERIAL (decrease stock)
// ============================================

export async function useMaterial(
  id: string,
  quantity: number,
  skuId?: string,
  notes?: string,
  userId?: string
): Promise<{
  success: boolean
  data?: Material
  error?: string
}> {
  const auth = await requireRole(MATERIALS_WRITE_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    if (quantity <= 0) {
      return { success: false, error: 'Quantity must be greater than 0' }
    }

    const db = await createServiceClient()

    // Get current material
    const { data: material, error: fetchError } = await db
      .from('materials')
      .select('*')
      .eq('id', id)
      .single()

    if (fetchError || !material) {
      return { success: false, error: 'Material not found' }
    }

    if (material.current_stock < quantity) {
      return { success: false, error: 'Insufficient stock' }
    }

    // Update stock
    const newStock = material.current_stock - quantity
    const { data, error: updateError } = await db
      .from('materials')
      .update({
        current_stock: newStock,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single()

    if (updateError) {
      console.error('Error using material:', updateError)
      return { success: false, error: updateError.message }
    }

    // Log transaction (negative quantity for usage)
    await db.from('material_transactions').insert({
      material_id: id,
      quantity: -quantity,
      transaction_type: 'usage',
      sku_id: skuId || null,
      user_id: userId || null,
      notes: notes?.trim() || null,
    })

    return { success: true, data }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

// ============================================
// GET MATERIAL TRANSACTIONS
// ============================================

export async function getMaterialTransactions(materialId?: string): Promise<{
  success: boolean
  data?: MaterialTransaction[]
  error?: string
}> {
  const auth = await requireRole(MATERIALS_READ_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const db = await createServiceClient()

    let query = db
      .from('material_transactions')
      .select(`
        *,
        material:materials(id, name, sku_code, material_type),
        user:users(id, name)
      `)
      .order('created_at', { ascending: false })
      .limit(100)

    if (materialId) {
      query = query.eq('material_id', materialId)
    }

    const { data, error } = await query

    if (error) {
      console.error('Error fetching transactions:', error)
      return { success: false, error: error.message }
    }

    return { success: true, data: data || [] }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

// ============================================
// ADJUST STOCK (manual correction)
// ============================================

export async function adjustMaterialStock(
  id: string,
  newStock: number,
  notes?: string,
  userId?: string
): Promise<{
  success: boolean
  data?: Material
  error?: string
}> {
  const auth = await requireRole(MATERIALS_WRITE_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    if (newStock < 0) {
      return { success: false, error: 'Stock cannot be negative' }
    }

    const db = await createServiceClient()

    // Get current material
    const { data: material, error: fetchError } = await db
      .from('materials')
      .select('*')
      .eq('id', id)
      .single()

    if (fetchError || !material) {
      return { success: false, error: 'Material not found' }
    }

    const difference = newStock - material.current_stock

    // Update stock
    const { data, error: updateError } = await db
      .from('materials')
      .update({
        current_stock: newStock,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single()

    if (updateError) {
      console.error('Error adjusting material stock:', updateError)
      return { success: false, error: updateError.message }
    }

    // Log transaction
    await db.from('material_transactions').insert({
      material_id: id,
      quantity: difference,
      transaction_type: 'adjustment',
      user_id: userId || null,
      notes: notes?.trim() || `Stock adjusted from ${material.current_stock} to ${newStock}`,
    })

    return { success: true, data }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

// ============================================
// SKU MATERIAL ASSIGNMENTS
// ============================================

export async function getSkuMaterials(skuId: string): Promise<{
  success: boolean
  data?: SkuMaterialWithDetails[]
  error?: string
}> {
  const auth = await requireRole(MATERIALS_READ_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const db = await createServiceClient()

    const { data, error } = await db
      .from('sku_materials')
      .select(`
        *,
        material:materials(*)
      `)
      .eq('sku_id', skuId)
      .order('created_at')

    if (error) {
      console.error('Error fetching SKU materials:', error)
      return { success: false, error: error.message }
    }

    return { success: true, data: data || [] }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

export async function assignMaterialToSku(
  skuId: string,
  materialId: string,
  quantityPerUnit: number
): Promise<{
  success: boolean
  data?: SkuMaterial
  error?: string
}> {
  const auth = await requireRole(MATERIALS_WRITE_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    if (quantityPerUnit <= 0) {
      return { success: false, error: 'Quantity per unit must be greater than 0' }
    }

    const db = await createServiceClient()

    // Check if assignment already exists
    const { data: existing } = await db
      .from('sku_materials')
      .select('id')
      .eq('sku_id', skuId)
      .eq('material_id', materialId)
      .maybeSingle()

    if (existing) {
      return { success: false, error: 'This material is already assigned to this SKU' }
    }

    const { data, error } = await db
      .from('sku_materials')
      .insert({
        sku_id: skuId,
        material_id: materialId,
        quantity_per_unit: quantityPerUnit,
      })
      .select()
      .single()

    if (error) {
      console.error('Error assigning material to SKU:', error)
      return { success: false, error: error.message }
    }

    return { success: true, data }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

export async function updateSkuMaterial(
  skuId: string,
  materialId: string,
  quantityPerUnit: number
): Promise<{
  success: boolean
  data?: SkuMaterial
  error?: string
}> {
  const auth = await requireRole(MATERIALS_WRITE_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    if (quantityPerUnit <= 0) {
      return { success: false, error: 'Quantity per unit must be greater than 0' }
    }

    const db = await createServiceClient()

    const { data, error } = await db
      .from('sku_materials')
      .update({
        quantity_per_unit: quantityPerUnit,
        updated_at: new Date().toISOString(),
      })
      .eq('sku_id', skuId)
      .eq('material_id', materialId)
      .select()
      .single()

    if (error) {
      console.error('Error updating SKU material:', error)
      return { success: false, error: error.message }
    }

    return { success: true, data }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

export async function removeSkuMaterial(
  skuId: string,
  materialId: string
): Promise<{
  success: boolean
  error?: string
}> {
  const auth = await requireRole(MATERIALS_WRITE_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const db = await createServiceClient()

    const { error } = await db
      .from('sku_materials')
      .delete()
      .eq('sku_id', skuId)
      .eq('material_id', materialId)

    if (error) {
      console.error('Error removing SKU material:', error)
      return { success: false, error: error.message }
    }

    return { success: true }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

// ============================================
// MATERIAL AVAILABILITY CHECK (for Packaging)
// ============================================

export interface MaterialAvailabilityResult {
  available: boolean
  materials: {
    materialId: string
    materialName: string
    required: number
    available: number
    shortage: number
  }[]
}

export async function checkMaterialAvailability(
  skuId: string,
  units: number
): Promise<{
  success: boolean
  data?: MaterialAvailabilityResult
  error?: string
}> {
  const auth = await requireRole(MATERIALS_READ_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const db = await createServiceClient()

    // Get materials required for this SKU
    const { data: skuMaterials, error: skuError } = await db
      .from('sku_materials')
      .select(`
        material_id,
        quantity_per_unit,
        material:materials(id, name, current_stock)
      `)
      .eq('sku_id', skuId)

    if (skuError) {
      console.error('Error checking material availability:', skuError)
      return { success: false, error: skuError.message }
    }

    if (!skuMaterials || skuMaterials.length === 0) {
      // No materials assigned - always available
      return {
        success: true,
        data: { available: true, materials: [] }
      }
    }

    const materials: MaterialAvailabilityResult['materials'] = []
    let allAvailable = true

    for (const sm of skuMaterials) {
      // Supabase returns joined data as arrays, extract first element
      const materialData = Array.isArray(sm.material) ? sm.material[0] : sm.material
      if (!materialData) continue

      const required = sm.quantity_per_unit * units
      const available = materialData.current_stock
      const shortage = Math.max(0, required - available)

      if (shortage > 0) {
        allAvailable = false
      }

      materials.push({
        materialId: materialData.id,
        materialName: materialData.name,
        required,
        available,
        shortage,
      })
    }

    return {
      success: true,
      data: { available: allAvailable, materials }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}

export async function deductMaterialsForCasing(
  skuId: string,
  units: number,
  userId?: string
): Promise<{
  success: boolean
  error?: string
}> {
  const auth = await requireRole(MATERIALS_WRITE_ROLES)
  if (!auth.authorized) return { success: false, error: auth.reason }

  try {
    const db = await createServiceClient()

    // Get materials required for this SKU
    const { data: skuMaterials, error: skuError } = await db
      .from('sku_materials')
      .select(`
        material_id,
        quantity_per_unit,
        material:materials(id, name, current_stock)
      `)
      .eq('sku_id', skuId)

    if (skuError) {
      console.error('Error fetching SKU materials:', skuError)
      return { success: false, error: skuError.message }
    }

    if (!skuMaterials || skuMaterials.length === 0) {
      // No materials assigned - nothing to deduct
      return { success: true }
    }

    // Check availability first
    for (const sm of skuMaterials) {
      // Supabase returns joined data as arrays, extract first element
      const materialData = Array.isArray(sm.material) ? sm.material[0] : sm.material
      if (!materialData) continue

      const required = sm.quantity_per_unit * units

      if (materialData.current_stock < required) {
        return {
          success: false,
          error: `Insufficient ${materialData.name}. Need ${required}, have ${materialData.current_stock}`
        }
      }
    }

    // Deduct all materials
    for (const sm of skuMaterials) {
      // Supabase returns joined data as arrays, extract first element
      const materialData = Array.isArray(sm.material) ? sm.material[0] : sm.material
      if (!materialData) continue

      const deductAmount = sm.quantity_per_unit * units
      const newStock = materialData.current_stock - deductAmount

      // Update stock
      const { error: updateError } = await db
        .from('materials')
        .update({
          current_stock: newStock,
          updated_at: new Date().toISOString()
        })
        .eq('id', materialData.id)

      if (updateError) {
        console.error('Error deducting material:', updateError)
        return { success: false, error: `Failed to deduct ${materialData.name}: ${updateError.message}` }
      }

      // Log transaction
      await db.from('material_transactions').insert({
        material_id: materialData.id,
        quantity: -deductAmount,
        transaction_type: 'usage',
        sku_id: skuId,
        user_id: userId || null,
        notes: `Casing: ${units} units`,
      })
    }

    return { success: true }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: errorMessage }
  }
}
