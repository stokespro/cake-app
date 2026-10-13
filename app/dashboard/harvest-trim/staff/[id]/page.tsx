import { StaffDetailClient } from '@/components/harvest-trim/staff-detail-client'

export default async function TrimStaffDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <StaffDetailClient id={id} />
}
