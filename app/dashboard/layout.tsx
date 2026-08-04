'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useAuth } from '@/lib/auth-context'
import { Button } from '@/components/ui/button'
import { ModeToggle } from '@/components/theme-toggle'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar'
import {
  MessageSquare,
  CheckSquare,
  LogOut,
  User,
  Users,
  BarChart3,
  Vault,
  Store,
  BadgeDollarSign,
  Package,
  Leaf,
  CircleGauge,
  Boxes,
  ClipboardList,
  Percent,
  DollarSign,
  ChevronDown,
  Sprout,
  LayoutGrid,
  Wallet,
  Factory,
  Warehouse,
} from 'lucide-react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
} from '@/components/ui/sidebar'

// Navigation item types
interface NavItem {
  name: string
  href: string
  icon: React.ComponentType<{ className?: string }>
  roles: string[]
}

// Top-level collapsible group with full child nav items
interface NavGroup {
  name: string
  icon: React.ComponentType<{ className?: string }>
  roles: string[]
  children: NavItem[]
}

// Legacy collapsible with simple sub-items (name+href only, no per-item roles)
interface NavItemWithSub {
  name: string
  icon: React.ComponentType<{ className?: string }>
  roles: string[]
  subItems: { name: string; href: string }[]
}

type NavigationItem = NavItem | NavGroup | NavItemWithSub

// Type guards
const hasChildren = (item: NavigationItem): item is NavGroup => {
  return 'children' in item
}

const hasSubItems = (item: NavigationItem): item is NavItemWithSub => {
  return 'subItems' in item
}

// Navigation structure with role restrictions
// roles: which roles can see this item (empty = all roles)
const allNavigation: NavigationItem[] = [
  // 1. Dashboard — flat link, all roles
  { name: 'Dashboard', href: '/dashboard', icon: CircleGauge, roles: [] },

  // 2. Operations group
  // NOTE: 'grow' is included at the group level ONLY so the "Cultivation" child
  // below is reachable — it is deliberately excluded from the "Packaging" and
  // "Packaging (New)" children (grow role is cultivation-only, per policy).
  {
    name: 'Operations',
    icon: Factory,
    roles: ['standard', 'packaging', 'vault', 'management', 'admin', 'grow'],
    children: [
      { name: 'Packaging', href: '/dashboard/packaging', icon: Package, roles: ['standard', 'packaging', 'vault', 'management', 'admin'] },
      { name: 'Packaging (New)', href: '/dashboard/packaging/board', icon: LayoutGrid, roles: ['packaging', 'vault', 'management', 'admin'] },
      { name: 'Cultivation', href: '/dashboard/cultivation', icon: Sprout, roles: ['vault', 'packaging', 'standard', 'management', 'admin', 'grow'] },
    ],
  },

  // 3. Inventory group
  {
    name: 'Inventory',
    icon: Warehouse,
    roles: ['vault', 'packaging', 'sales', 'agent', 'standard', 'management', 'admin'],
    children: [
      { name: 'Inventory', href: '/dashboard/inventory', icon: BarChart3, roles: ['vault', 'packaging', 'sales', 'agent', 'management', 'admin'] },
      { name: 'Vault', href: '/dashboard/vault', icon: Vault, roles: ['standard', 'vault', 'packaging', 'management', 'admin'] },
      { name: 'Products', href: '/dashboard/products', icon: Leaf, roles: ['standard', 'vault', 'packaging', 'management', 'admin'] },
      { name: 'Materials', href: '/dashboard/materials', icon: Boxes, roles: ['packaging', 'management', 'admin'] },
    ],
  },

  // 4. Sales group — includes CRM items and commission sub-items (admin only)
  {
    name: 'Sales',
    icon: Store,
    roles: ['sales', 'agent', 'management', 'admin'],
    children: [
      { name: 'Orders', href: '/dashboard/orders', icon: BadgeDollarSign, roles: ['sales', 'agent', 'management', 'admin'] },
      { name: 'Dispensaries', href: '/dashboard/dispensaries', icon: Store, roles: ['sales', 'agent', 'management', 'admin'] },
      { name: 'Communications', href: '/dashboard/communications', icon: MessageSquare, roles: ['sales', 'agent', 'management', 'admin'] },
      { name: 'Tasks', href: '/dashboard/tasks', icon: CheckSquare, roles: ['sales', 'agent', 'management', 'admin'] },
      { name: 'My Commissions', href: '/dashboard/my-commissions', icon: DollarSign, roles: ['sales', 'agent', 'management', 'admin'] },
      // Commission admin tools — moved from standalone Commissions group, now admin-only (delta)
      { name: 'Commission Reports', href: '/dashboard/commissions', icon: Percent, roles: ['admin'] },
      { name: 'Commission Rates', href: '/dashboard/commissions/rates', icon: Percent, roles: ['admin'] },
    ],
  },

  // 5. Compliance — existing collapsible group, unchanged
  {
    name: 'Compliance',
    icon: ClipboardList,
    roles: ['vault', 'packaging', 'management', 'admin'],
    subItems: [
      { name: 'Compliance Log', href: '/dashboard/compliance' },
      { name: 'DEA Briefing', href: '/dashboard/compliance/dea-briefing' },
    ]
  },

  // 6. Finance — existing collapsible group, unchanged
  {
    name: 'Finance',
    icon: Wallet,
    roles: ['admin', 'management'],
    subItems: [
      { name: 'Overview', href: '/dashboard/finance' },
      { name: 'Bills', href: '/dashboard/finance/bills' },
      { name: 'Templates', href: '/dashboard/finance/templates' },
      { name: 'Vendors', href: '/dashboard/finance/vendors' },
    ]
  },

  // 7. Users — flat link, admin only
  { name: 'Users', href: '/dashboard/users', icon: Users, roles: ['admin'] },
]

function AppSidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const { user, logout } = useAuth()
  const { setOpenMobile, isMobile } = useSidebar()

  // Close mobile sidebar when navigating
  const handleNavClick = () => {
    if (isMobile) {
      setOpenMobile(false)
    }
  }

  if (!user) return null

  // Get navigation items based on user role
  const getNavigationItems = () => {
    return allNavigation.filter(item => {
      // Empty roles array means all roles can access
      if (item.roles.length === 0) return true
      // Check if user's role is in the allowed roles
      return item.roles.includes(user.role)
    })
  }

  const handleSignOut = () => {
    logout()
    router.push('/login')
  }

  const navigation = getNavigationItems()

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link href="/dashboard" onClick={handleNavClick}>
                <div className="flex aspect-square size-8 items-center justify-center">
                  <img
                    src="/cake-icon-black.svg"
                    alt="CAKE"
                    className="h-8 w-auto dark:hidden"
                  />
                  <img
                    src="/cake-icon-white.svg"
                    alt="CAKE"
                    className="h-8 w-auto hidden dark:block"
                  />
                </div>
                <div className="flex flex-col gap-0.5 leading-none">
                  <span className="font-semibold">CAKE</span>
                  <span className="text-xs text-muted-foreground">CRM</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {navigation.map((item) => {
              // Top-level collapsible group with full child nav items (roles per child)
              if (hasChildren(item)) {
                const visibleChildren = item.children.filter(child =>
                  child.roles.length === 0 || child.roles.includes(user.role)
                )
                if (visibleChildren.length === 0) return null

                const isAnyChildActive = visibleChildren.some(child => pathname === child.href)
                return (
                  <Collapsible
                    key={item.name}
                    asChild
                    defaultOpen={isAnyChildActive}
                    className="group/collapsible"
                  >
                    <SidebarMenuItem>
                      <CollapsibleTrigger asChild>
                        <SidebarMenuButton
                          tooltip={item.name}
                          isActive={isAnyChildActive}
                        >
                          <item.icon className="h-4 w-4" />
                          <span>{item.name}</span>
                          <ChevronDown className="ml-auto h-4 w-4 transition-transform duration-200 group-data-[state=open]/collapsible:rotate-180" />
                        </SidebarMenuButton>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <SidebarMenuSub>
                          {visibleChildren.map((child) => (
                            <SidebarMenuSubItem key={child.name}>
                              <SidebarMenuSubButton
                                asChild
                                isActive={pathname === child.href}
                              >
                                <Link href={child.href} onClick={handleNavClick}>
                                  <span>{child.name}</span>
                                </Link>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          ))}
                        </SidebarMenuSub>
                      </CollapsibleContent>
                    </SidebarMenuItem>
                  </Collapsible>
                )
              }

              // Legacy collapsible with simple sub-items (Compliance, Finance)
              if (hasSubItems(item)) {
                const isAnySubActive = item.subItems.some(sub => pathname === sub.href)
                return (
                  <Collapsible
                    key={item.name}
                    asChild
                    defaultOpen={isAnySubActive}
                    className="group/collapsible"
                  >
                    <SidebarMenuItem>
                      <CollapsibleTrigger asChild>
                        <SidebarMenuButton
                          tooltip={item.name}
                          isActive={isAnySubActive}
                        >
                          <item.icon className="h-4 w-4" />
                          <span>{item.name}</span>
                          <ChevronDown className="ml-auto h-4 w-4 transition-transform duration-200 group-data-[state=open]/collapsible:rotate-180" />
                        </SidebarMenuButton>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <SidebarMenuSub>
                          {item.subItems.map((subItem) => (
                            <SidebarMenuSubItem key={subItem.name}>
                              <SidebarMenuSubButton
                                asChild
                                isActive={pathname === subItem.href}
                              >
                                <Link href={subItem.href} onClick={handleNavClick}>
                                  <span>{subItem.name}</span>
                                </Link>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          ))}
                        </SidebarMenuSub>
                      </CollapsibleContent>
                    </SidebarMenuItem>
                  </Collapsible>
                )
              }

              // Regular flat link
              const isActive = pathname === item.href
              return (
                <SidebarMenuItem key={item.name}>
                  <SidebarMenuButton
                    asChild
                    isActive={isActive}
                    tooltip={item.name}
                  >
                    <Link href={(item as NavItem).href} onClick={handleNavClick}>
                      <item.icon className="h-4 w-4" />
                      <span>{item.name}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip={`${user.name} (${user.role})`}>
              <User className="h-4 w-4" />
              <div className="flex flex-col gap-0.5 leading-none">
                <span className="font-medium">{user.name}</span>
                <span className="text-xs text-muted-foreground capitalize">{user.role}</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={handleSignOut}
              tooltip="Sign Out"
              className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/20"
            >
              <LogOut className="h-4 w-4" />
              <span>Sign Out</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <div className="flex items-center justify-center p-2 group-data-[collapsible=icon]:p-0">
              <ModeToggle />
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const router = useRouter()
  const { user, isLoading } = useAuth()

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!isLoading && !user) {
      router.push('/login')
    }
  }, [user, isLoading, router])

  // Show nothing while checking auth
  if (isLoading || !user) {
    return (
      <div className="flex h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-900">
        <div className="text-zinc-500">Loading...</div>
      </div>
    )
  }

  return (
    <SidebarProvider>
      <AppSidebar />
      <div className="flex flex-1 flex-col min-w-0">
        {/* Header with sidebar trigger */}
        <header className="flex h-14 shrink-0 items-center gap-4 border-b bg-background px-4">
          <SidebarTrigger className="-ml-1" />
          <div className="flex-1" />
        </header>

        {/* Page Content */}
        <main className="flex-1 min-w-0 overflow-auto">
          <div className="p-4 md:p-6 max-w-7xl mx-auto">
            {children}
          </div>
        </main>
      </div>
    </SidebarProvider>
  )
}
