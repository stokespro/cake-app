// SPRO-234: a package's strain is owned by its batch. packages.strain_id and the
// denormalized packages.strain text are always derived from batches.strain_id,
// never taken from client input (inventory groups by packages.strain_id).

export interface BatchStrainSource {
  name: string
  strain_id: string | null
}

export type PackageStrainResult =
  | { ok: true; strainId: string; strainName: string }
  | { ok: false; error: string }

export function derivePackageStrain(
  batch: BatchStrainSource | null | undefined,
  strain: { id: string; name: string } | null | undefined,
  batchName: string
): PackageStrainResult {
  if (!batch) {
    return { ok: false, error: `Batch "${batchName}" not found` }
  }
  if (!batch.strain_id) {
    return { ok: false, error: `Batch "${batch.name}" has no strain assigned. Set a strain on the batch first.` }
  }
  if (!strain || strain.id !== batch.strain_id) {
    return { ok: false, error: `Strain for batch "${batch.name}" could not be found` }
  }
  return { ok: true, strainId: strain.id, strainName: strain.name }
}
