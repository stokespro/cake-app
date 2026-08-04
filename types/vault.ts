// Vault-specific types

export interface ProductType {
  id: string
  name: string
  created_at: string
}

export interface Strain {
  id: string
  name: string
  created_at: string
}

export interface Batch {
  id: string
  name: string
  strain_id: string
  is_active: boolean
  created_at: string
  thc_percentage?: number | null
  terpenes_percentage?: number | null
  total_cannabinoids_percentage?: number | null
  coa_url?: string | null
  coa_path?: string | null
  coa_filename?: string | null
  coa_uploaded_at?: string | null
  coa_uploaded_by?: string | null
  strain?: Strain
}

export interface VaultPackage {
  tag_id: string
  batch: string
  strain: string
  strain_id?: string
  type_id: string
  current_weight: number
  is_active: boolean
  created_by: string
  created_at: string
  updated_at: string
  // Joined fields
  type?: ProductType
  strain_info?: Strain
  creator?: { id: string; name: string }
}

export interface Transaction {
  id: string
  tag_id: string
  user_id: string
  type: 'add' | 'remove'
  amount: number
  resulting_balance: number
  created_at: string
  user?: { id: string; name: string }
}

export interface PackageFilters {
  batches?: string[]
  strainIds?: string[]
  typeIds?: string[]
}
