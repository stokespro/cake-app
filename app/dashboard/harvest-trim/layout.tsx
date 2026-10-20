import { TrimShell } from '@/components/harvest-trim/trim-shell'

export default function HarvestTrimLayout({ children }: { children: React.ReactNode }) {
  return <TrimShell>{children}</TrimShell>
}
