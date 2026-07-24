'use client'

import { useState } from 'react'
import { DispensaryProfile } from '@/types/database'
import { useAuth } from '@/lib/auth-context'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { updateCustomer } from '@/actions/customers'

interface EditDispensarySheetProps {
  open: boolean
  onClose: () => void
  dispensary: DispensaryProfile | null
  onSuccess?: () => void
}

interface FormData {
  business_name: string
  license_name: string
  address: string
  phone_number: string
  email: string
  omma_license: string
  ob_license: string
  is_active: boolean
  commission_exempt: boolean
}

export function EditDispensarySheet({
  open,
  onClose,
  dispensary,
  onSuccess
}: EditDispensarySheetProps) {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'

  const [formData, setFormData] = useState<FormData>({
    business_name: dispensary?.business_name || '',
    license_name: dispensary?.license_name || '',
    address: dispensary?.address || '',
    phone_number: dispensary?.phone_number || '',
    email: dispensary?.email || '',
    omma_license: dispensary?.omma_license || '',
    ob_license: dispensary?.ob_license || '',
    is_active: dispensary?.is_active !== false,
    commission_exempt: dispensary?.commission_exempt === true
  })
  const [loading, setLoading] = useState(false)
  const [errors, setErrors] = useState<Partial<FormData>>({})

  // Reset form when dispensary changes
  const resetForm = () => {
    setFormData({
      business_name: dispensary?.business_name || '',
      license_name: dispensary?.license_name || '',
      address: dispensary?.address || '',
      phone_number: dispensary?.phone_number || '',
      email: dispensary?.email || '',
      omma_license: dispensary?.omma_license || '',
      ob_license: dispensary?.ob_license || '',
      is_active: dispensary?.is_active !== false,
      commission_exempt: dispensary?.commission_exempt === true
    })
    setErrors({})
  }

  // Handle open state changes
  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) {
      onClose()
      resetForm()
    }
  }

  // Handle input changes
  const handleInputChange = (field: keyof FormData, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }))
    // Clear error for this field when user starts typing
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: undefined }))
    }
  }

  // Form validation
  const validateForm = (): boolean => {
    const newErrors: Partial<FormData> = {}

    if (!formData.business_name.trim()) {
      newErrors.business_name = 'Business name is required'
    }

    // Email validation
    if (formData.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      newErrors.email = 'Please enter a valid email address'
    }

    // Phone validation (basic)
    if (formData.phone_number && !/^[\+\(\)\-\.\s\d]+$/.test(formData.phone_number)) {
      newErrors.phone_number = 'Please enter a valid phone number'
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  // Handle form submission
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!dispensary || !validateForm()) {
      return
    }

    setLoading(true)

    const result = await updateCustomer(dispensary.id, {
      business_name: formData.business_name,
      license_name: formData.license_name,
      address: formData.address,
      phone_number: formData.phone_number,
      email: formData.email,
      omma_license: formData.omma_license,
      ob_license: formData.ob_license,
      is_active: formData.is_active,
      commission_exempt: formData.commission_exempt,
    })

    setLoading(false)

    if (result.error) {
      console.error('Error updating dispensary:', result.error)
      toast.error(result.error)
      return
    }

    toast.success('Dispensary updated successfully')
    onSuccess?.()
    onClose()
    resetForm()
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent className="w-full sm:max-w-lg">
        <form onSubmit={handleSubmit} className="flex flex-col h-full">
          <SheetHeader>
            <SheetTitle>Edit Dispensary</SheetTitle>
            <SheetDescription>
              Update the dispensary information. Only the business name is required.
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 space-y-4 py-6">
            {/* Business Name */}
            <div className="space-y-2">
              <Label htmlFor="business_name">
                Business Name <span className="text-red-500">*</span>
              </Label>
              <Input
                id="business_name"
                placeholder="Green Valley Dispensary"
                value={formData.business_name}
                onChange={(e) => handleInputChange('business_name', e.target.value)}
                disabled={loading}
                className={errors.business_name ? 'border-red-500' : ''}
              />
              {errors.business_name && (
                <p className="text-sm text-red-600">{errors.business_name}</p>
              )}
            </div>

            {/* License Name */}
            <div className="space-y-2">
              <Label htmlFor="license_name">License Name</Label>
              <Input
                id="license_name"
                placeholder="Legal entity name (LLC)"
                value={formData.license_name}
                onChange={(e) => handleInputChange('license_name', e.target.value)}
                disabled={loading}
              />
            </div>

            {/* Address */}
            <div className="space-y-2">
              <Label htmlFor="address">Address</Label>
              <Input
                id="address"
                placeholder="123 Main St, City, State 12345"
                value={formData.address}
                onChange={(e) => handleInputChange('address', e.target.value)}
                disabled={loading}
              />
            </div>

            {/* Phone Number */}
            <div className="space-y-2">
              <Label htmlFor="phone_number">Phone Number</Label>
              <Input
                id="phone_number"
                type="tel"
                placeholder="(555) 123-4567"
                value={formData.phone_number}
                onChange={(e) => handleInputChange('phone_number', e.target.value)}
                disabled={loading}
                className={errors.phone_number ? 'border-red-500' : ''}
              />
              {errors.phone_number && (
                <p className="text-sm text-red-600">{errors.phone_number}</p>
              )}
            </div>

            {/* Email */}
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="contact@dispensary.com"
                value={formData.email}
                onChange={(e) => handleInputChange('email', e.target.value)}
                disabled={loading}
                className={errors.email ? 'border-red-500' : ''}
              />
              {errors.email && (
                <p className="text-sm text-red-600">{errors.email}</p>
              )}
            </div>

            {/* OMMA License */}
            <div className="space-y-2">
              <Label htmlFor="omma_license">OMMA License</Label>
              <Input
                id="omma_license"
                placeholder="OMMA-XXXX-XXXX"
                value={formData.omma_license}
                onChange={(e) => handleInputChange('omma_license', e.target.value)}
                disabled={loading}
              />
            </div>

            {/* OB License */}
            <div className="space-y-2">
              <Label htmlFor="ob_license">OB License</Label>
              <Input
                id="ob_license"
                placeholder="OB-XXXX-XXXX"
                value={formData.ob_license}
                onChange={(e) => handleInputChange('ob_license', e.target.value)}
                disabled={loading}
              />
            </div>

            {/* Active Status */}
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="is_active" className="text-sm font-medium">Active Status</Label>
                <p className="text-xs text-muted-foreground">
                  Inactive dispensaries are hidden from default lists and dropdowns
                </p>
              </div>
              <Switch
                id="is_active"
                checked={formData.is_active}
                onCheckedChange={(checked) => setFormData(prev => ({ ...prev, is_active: checked }))}
                disabled={loading}
              />
            </div>

            {/* Commission Exempt (admin only) */}
            {isAdmin && (
              <div className="flex items-center justify-between rounded-lg border p-3">
                <div className="space-y-0.5">
                  <Label htmlFor="commission_exempt" className="text-sm font-medium">Commission Exempt</Label>
                  <p className="text-xs text-muted-foreground">
                    Exempt this dispensary from all sales commission calculations. Delivered orders will not generate commissions for the assigned sales rep.
                  </p>
                </div>
                <Switch
                  id="commission_exempt"
                  checked={formData.commission_exempt}
                  onCheckedChange={(checked) => setFormData(prev => ({ ...prev, commission_exempt: checked }))}
                  disabled={loading}
                />
              </div>
            )}
          </div>

          <SheetFooter className="gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={loading}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={loading || !dispensary}
              className="flex-1"
            >
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Updating...
                </>
              ) : (
                'Update Dispensary'
              )}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
