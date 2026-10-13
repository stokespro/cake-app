import { PayReviewClient } from '@/components/harvest-trim/pay-review-client'

export default async function TrimBatchPayPage({ params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params
  return <PayReviewClient batchId={batchId} />
}
