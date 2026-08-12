// Shared Supabase Storage bucket name constants. Kept in a plain module
// (not a 'use server' actions file) so both server actions and client
// components can import the same literal instead of duplicating it —
// 'use server' files may only export async functions, so a bucket-name
// constant can't live in actions/vault.ts.

// Public bucket for brand assets (strain logos/backgrounds, etc.) — writes
// only via signed upload URLs.
export const BRAND_ASSETS_BUCKET = 'brand-assets'
