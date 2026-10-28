// SPRO-234: package strain must come from its batch.
import { describe, expect, it } from 'vitest'
import { derivePackageStrain } from './package-strain'

const STRAIN = { id: 'strain-aloha', name: 'Aloha Sugar' }

describe('derivePackageStrain', () => {
  it('returns the batch strain id and the strain row name', () => {
    expect(
      derivePackageStrain({ name: '0824-F5-AS', strain_id: 'strain-aloha' }, STRAIN, '0824-F5-AS')
    ).toEqual({ ok: true, strainId: 'strain-aloha', strainName: 'Aloha Sugar' })
  })

  it('fails when the batch does not exist', () => {
    const r = derivePackageStrain(null, null, 'nope')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('nope')
  })

  it('fails when the batch has no strain_id', () => {
    const r = derivePackageStrain({ name: 'B1', strain_id: null }, null, 'B1')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('no strain')
  })

  it('fails when the strain row is missing or does not match the batch', () => {
    expect(derivePackageStrain({ name: 'B1', strain_id: 'x' }, null, 'B1').ok).toBe(false)
    expect(derivePackageStrain({ name: 'B1', strain_id: 'x' }, STRAIN, 'B1').ok).toBe(false)
  })
})
