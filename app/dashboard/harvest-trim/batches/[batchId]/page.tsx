import { BatchDetailClient } from '@/components/harvest-trim/batch-detail-client'

export default async function TrimBatchPage({ params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params
  return <BatchDetailClient batchId={batchId} />
}
