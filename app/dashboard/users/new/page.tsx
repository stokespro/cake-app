'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createUser } from '@/actions/users'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { deriveInitials } from '@/lib/initials'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ArrowLeft, Save, User, RefreshCw } from 'lucide-react'
import Link from 'next/link'

// Generate a random 4-digit PIN
const generatePin = () => {
  return Math.floor(1000 + Math.random() * 9000).toString()
}

export default function NewUserPage() {
  const [loading, setLoading] = useState(false)
  const [formData, setFormData] = useState({
    name: '',
    initials: '',
    pin: generatePin(),
    role: 'standard',
    slack_user_id: ''
  })

  const router = useRouter()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)

    try {
      const result = await createUser({
        name: formData.name,
        initials: formData.initials,
        pin: formData.pin,
        role: formData.role,
        slack_user_id: formData.slack_user_id,
      })

      if (result.error) {
        alert(result.error)
        return
      }

      router.push('/dashboard/users')
    } catch (error: unknown) {
      console.error('Error creating user:', error)
      alert(error instanceof Error ? error.message : 'An error occurred while creating the user')
    } finally {
      setLoading(false)
    }
  }

  const handleInputChange = (field: string, value: string) => {
    setFormData(prev => ({
      ...prev,
      [field]: value
    }))
  }

  const regeneratePin = () => {
    setFormData(prev => ({
      ...prev,
      pin: generatePin()
    }))
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/dashboard/users">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">Add New User</h1>
          <p className="text-muted-foreground">Create a new user account</p>
        </div>
      </div>

      {/* Form */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <User className="h-5 w-5" />
            User Information
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Name */}
            <div className="space-y-2">
              <Label htmlFor="name">
                Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="name"
                placeholder="John Doe"
                value={formData.name}
                onChange={(e) => handleInputChange('name', e.target.value)}
                required
              />
            </div>

            {/* Initials */}
            <div className="space-y-2">
              <Label htmlFor="initials">Map initials</Label>
              <Input
                id="initials"
                placeholder={deriveInitials(formData.name)}
                value={formData.initials}
                maxLength={3}
                className="w-24 uppercase"
                onChange={(e) => handleInputChange('initials', e.target.value.toUpperCase().slice(0, 3))}
              />
              <p className="text-xs text-muted-foreground">
                Shown on dispensary map pins for accounts this user is assigned to.
                Leave blank to use{' '}
                <span className="font-medium">{deriveInitials(formData.name)}</span>.
              </p>
            </div>

            {/* PIN */}
            <div className="space-y-2">
              <Label htmlFor="pin">
                Login PIN <span className="text-destructive">*</span>
              </Label>
              <div className="flex gap-2">
                <Input
                  id="pin"
                  type="text"
                  inputMode="numeric"
                  pattern="\d{4}"
                  maxLength={4}
                  placeholder="4-digit PIN"
                  value={formData.pin}
                  onChange={(e) => handleInputChange('pin', e.target.value.replace(/\D/g, '').slice(0, 4))}
                  className="font-mono text-lg tracking-widest"
                  required
                />
                <Button type="button" variant="outline" onClick={regeneratePin}>
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">
                This 4-digit PIN will be used for login. Share it securely with the user.
              </p>
            </div>

            {/* Role */}
            <div className="space-y-2">
              <Label htmlFor="role">
                User Role <span className="text-destructive">*</span>
              </Label>
              <Select value={formData.role} onValueChange={(value) => handleInputChange('role', value)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="management">Management</SelectItem>
                  <SelectItem value="sales">Sales</SelectItem>
                  <SelectItem value="agent">Agent</SelectItem>
                  <SelectItem value="vault">Vault</SelectItem>
                  <SelectItem value="packaging">Packaging</SelectItem>
                  <SelectItem value="standard">Standard</SelectItem>
                  <SelectItem value="grow">Grow</SelectItem>
                </SelectContent>
              </Select>
              <div className="text-sm text-muted-foreground space-y-1">
                <p><strong>Admin:</strong> Full system access including user management</p>
                <p><strong>Management:</strong> Full access to all sections. Can approve and edit orders</p>
                <p><strong>Sales:</strong> Access to Dispensaries, Orders, Comms, Tasks, My Commissions</p>
                <p><strong>Agent:</strong> Same access as Sales</p>
                <p><strong>Vault:</strong> Access to Vault, Packaging, Inventory, Products</p>
                <p><strong>Packaging:</strong> Access to Packaging, Materials, Inventory, Products</p>
                <p><strong>Standard:</strong> Access to Vault, Packaging, Products</p>
                <p><strong>Grow:</strong> Cultivation only — view and complete cultivation tasks, plus the cultivation wall-display monitor</p>
              </div>
            </div>

            {/* Slack User ID */}
            <div className="space-y-2">
              <Label htmlFor="slack_user_id">Slack User ID</Label>
              <Input
                id="slack_user_id"
                placeholder="e.g., U07XXXXXXXX"
                value={formData.slack_user_id}
                onChange={(e) => handleInputChange('slack_user_id', e.target.value)}
              />
              <p className="text-sm text-muted-foreground">
                Optional. Links this user to their Slack account for notifications and integrations.
              </p>
            </div>

            {/* Actions */}
            <div className="flex gap-4 pt-4">
              <Button type="submit" disabled={loading} className="flex-1">
                {loading ? (
                  'Creating User...'
                ) : (
                  <>
                    <Save className="mr-2 h-4 w-4" />
                    Create User
                  </>
                )}
              </Button>
              <Button type="button" variant="outline" asChild>
                <Link href="/dashboard/users">Cancel</Link>
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Help Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">User Creation Process</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>1. Enter the user&apos;s name</p>
          <p>2. A 4-digit PIN is auto-generated (you can regenerate or edit it)</p>
          <p>3. Select the appropriate role based on their responsibilities</p>
          <p>4. Share the PIN securely with the user for login</p>
        </CardContent>
      </Card>
    </div>
  )
}
