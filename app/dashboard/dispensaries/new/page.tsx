'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/lib/auth-context'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { createCustomer } from '@/actions/customers'

export default function NewDispensaryPage() {
  const [businessName, setBusinessName] = useState('')
  const [licenseName, setLicenseName] = useState('')
  const [address, setAddress] = useState('')
  const [phoneNumber, setPhoneNumber] = useState('')
  const [email, setEmail] = useState('')
  const [ommaLicense, setOmmaLicense] = useState('')
  const [obLicense, setObLicense] = useState('')
  const [deaNumber, setDeaNumber] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()
  const { user } = useAuth()

  // Roles that can add dispensaries: sales, agent, management, admin
  const userRole = user?.role || 'standard'
  const canAddDispensary = ['sales', 'agent', 'management', 'admin'].includes(userRole)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    // Auto-assign to sales user if they're the one creating
    const assignedSalesId = userRole === 'sales' ? user?.id : null

    const result = await createCustomer({
      business_name: businessName,
      license_name: licenseName || undefined,
      address: address || undefined,
      phone_number: phoneNumber || undefined,
      email: email || undefined,
      omma_license: ommaLicense || undefined,
      ob_license: obLicense || undefined,
      dea_number: deaNumber || undefined,
      assigned_sales_id: assignedSalesId,
    })

    if (result.error) {
      setError(result.error)
      setLoading(false)
      return
    }

    router.push('/dashboard/dispensaries')
  }

  if (!canAddDispensary) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-muted-foreground">You do not have permission to add dispensaries.</div>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/dashboard/dispensaries">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">Add Dispensary</h1>
          <p className="text-muted-foreground mt-1">Create a new dispensary profile</p>
        </div>
      </div>

      {/* Form */}
      <Card>
        <CardHeader>
          <CardTitle>Dispensary Information</CardTitle>
          <CardDescription>
            Enter the dispensary details. Only the business name is required.
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-4">
            {error && (
              <div className="p-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md">
                {error}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="businessName">Business Name *</Label>
              <Input
                id="businessName"
                placeholder="Green Valley Dispensary"
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
                required
                disabled={loading}
                className="h-12"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="licenseName">License Name</Label>
              <Input
                id="licenseName"
                placeholder="Legal entity name (LLC)"
                value={licenseName}
                onChange={(e) => setLicenseName(e.target.value)}
                disabled={loading}
                className="h-12"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="address">Address</Label>
              <Input
                id="address"
                placeholder="123 Main St, City, State 12345"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                disabled={loading}
                className="h-12"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="phoneNumber">Phone Number</Label>
                <Input
                  id="phoneNumber"
                  type="tel"
                  placeholder="(555) 123-4567"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  disabled={loading}
                  className="h-12"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="contact@dispensary.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={loading}
                  className="h-12"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="ommaLicense">OMMA License</Label>
                <Input
                  id="ommaLicense"
                  placeholder="OMMA-XXXX-XXXX"
                  value={ommaLicense}
                  onChange={(e) => setOmmaLicense(e.target.value)}
                  disabled={loading}
                  className="h-12"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="obLicense">OB License</Label>
                <Input
                  id="obLicense"
                  placeholder="OB-XXXX-XXXX"
                  value={obLicense}
                  onChange={(e) => setObLicense(e.target.value)}
                  disabled={loading}
                  className="h-12"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="deaNumber">DEA #</Label>
              <Input
                id="deaNumber"
                placeholder="AB1234567"
                value={deaNumber}
                onChange={(e) => setDeaNumber(e.target.value)}
                disabled={loading}
                className="h-12"
              />
            </div>
          </CardContent>

          <div className="flex gap-3 p-6 pt-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => router.back()}
              disabled={loading}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading} className="flex-1">
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                'Add Dispensary'
              )}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  )
}
