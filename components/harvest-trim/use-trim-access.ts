'use client'

import { useMemo } from 'react'
import {
  canApproveTrimPay,
  canManageTrimStaff,
  canOperateTrim,
  canSeeTrimPay,
  canViewSection,
  canWeighHarvest,
  useAuth,
} from '@/lib/auth-context'
import { TRIM_ADMIN_ROLES, roleAllowed } from '@/lib/trim/roles'

export interface TrimAccess {
  /** False until the session has loaded. */
  ready: boolean
  role: string | null
  canView: boolean
  canWeigh: boolean
  /** Trim station operations (checkout, check-in, hanger registry). */
  canOperate: boolean
  /** Dollars and pay rates. Only `grow` is denied. */
  canSeePay: boolean
  canManageStaff: boolean
  canApprovePay: boolean
  /** Variance settings, reopen a reconciled load, void a partial load. */
  isAdmin: boolean
  /** Reopen a closed batch. Narrower than isAdmin: the action is admin only. */
  canReopenBatch: boolean
  /** The pay register and the bills it points at (admin, management). */
  isFinance: boolean
}

export function useTrimAccess(): TrimAccess {
  const { user, isLoading } = useAuth()
  return useMemo(() => {
    if (!user) {
      return {
        ready: !isLoading,
        role: null,
        canView: false,
        canWeigh: false,
        canOperate: false,
        canSeePay: false,
        canManageStaff: false,
        canApprovePay: false,
        isAdmin: false,
        canReopenBatch: false,
        isFinance: false,
      }
    }
    return {
      ready: true,
      role: user.role,
      canView: canViewSection(user.role, 'harvestTrim'),
      canWeigh: canWeighHarvest(user.role),
      canOperate: canOperateTrim(user.role),
      canSeePay: canSeeTrimPay(user.role),
      canManageStaff: canManageTrimStaff(user.role),
      canApprovePay: canApproveTrimPay(user.role),
      isAdmin: roleAllowed(TRIM_ADMIN_ROLES, user.role),
      canReopenBatch: user.role === 'admin',
      isFinance: canViewSection(user.role, 'finance'),
    }
  }, [user, isLoading])
}
