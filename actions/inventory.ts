'use server'

import { requireRole } from '@/lib/auth/session'
import { filterEligiblePackages } from '@/lib/inventory/package-eligibility'
import { createServiceClient } from '@/lib/supabase/server'

// Roles that can view inventory (matches canViewSection 'inventory')
const INVENTORY_READ_ROLES = ['admin', 'management', 'vault', 'packaging', 'standard', 'sales', 'agent']

export interface InventorySku {
  id: string
  code: string
  name: string
  strain_id: string
  product_type_id: string
  grams_per_unit: number
  units_per_case: number
}

export interface InventoryStrain {
  id: string
  name: string
}

export interface InventoryProductType {
  id: string
  name: string
}

export interface InventoryRecord {
  sku_id: string
  cased: number
  filled: number
  staged: number
}

export interface InventoryPackage {
  strain_id: string
  type_id: string
  current_weight: number
  is_active: boolean
}

export interface InventoryOrderItem {
  sku_id: string
  quantity: number
}

export interface InventoryOrder {
  id: string
  status: string
  order_items: InventoryOrderItem[]
}

export interface InventoryData {
  skus: InventorySku[]
  strains: InventoryStrain[]
  productTypes: InventoryProductType[]
  inventory: InventoryRecord[]
  packages: InventoryPackage[]
  orders: InventoryOrder[]
}

export async function getInventoryData(): Promise<
  { data: InventoryData; error?: never } | { data?: never; error: string }
> {
  const auth = await requireRole(INVENTORY_READ_ROLES)
  if (!auth.authorized) return { error: auth.reason }

  const db = await createServiceClient()

  const [
    skusResult,
    strainsResult,
    productTypesResult,
    inventoryResult,
    packagesResult,
    ordersResult,
  ] = await Promise.all([
    db.from('skus').select('id, code, name, strain_id, product_type_id, grams_per_unit, units_per_case').eq('status', 'active').order('code'),
    db.from('strains').select('id, name'),
    db.from('product_types').select('id, name'),
    db.from('inventory').select('sku_id, cased, filled, staged'),
    db.from('packages').select('strain_id, type_id, current_weight, is_active').eq('is_active', true),
    // Only pending/confirmed orders represent uncommitted cases — packed orders have
    // already had their units physically deducted from inventory.cased, so counting
    // them again would double-count and under-report available stock.
    db.from('orders').select('id, status, order_items(sku_id, quantity)').in('status', ['pending', 'confirmed']),
  ])

  if (skusResult.error) {
    console.error('[inventory] skus error:', skusResult.error)
    return { error: skusResult.error.message }
  }
  if (strainsResult.error) {
    console.error('[inventory] strains error:', strainsResult.error)
    return { error: strainsResult.error.message }
  }
  if (productTypesResult.error) {
    console.error('[inventory] product_types error:', productTypesResult.error)
    return { error: productTypesResult.error.message }
  }
  if (inventoryResult.error) {
    console.error('[inventory] inventory error:', inventoryResult.error)
    return { error: inventoryResult.error.message }
  }
  if (packagesResult.error) {
    console.error('[inventory] packages error:', packagesResult.error)
    return { error: packagesResult.error.message }
  }
  if (ordersResult.error) {
    console.error('[inventory] orders error:', ordersResult.error)
    return { error: ordersResult.error.message }
  }

  const productTypes = productTypesResult.data || []

  // SPRO-150: availability is aggregated from these packages, so drop the ones
  // that are too light to count BEFORE the caller sums them — two half-full
  // A Buds packages are two sealed containers, not one case. Vault reads
  // packages through actions/vault.ts and is unaffected.
  const productTypeNameById = new Map(productTypes.map(t => [t.id, t.name]))
  const packages = filterEligiblePackages(packagesResult.data || [], productTypeNameById)

  return {
    data: {
      skus: skusResult.data || [],
      strains: strainsResult.data || [],
      productTypes,
      inventory: inventoryResult.data || [],
      packages,
      orders: (ordersResult.data || []) as InventoryOrder[],
    }
  }
}
