// Bump this version whenever the terms' obligations change, and publish the
// matching page before turning on TERMS_ACCEPTANCE_REQUIRED.
export const termsVersion = "2026-11-06.1"
export const termsUrl = "https://www.cyntch.com/legal/terms"
export interface TermsStatus { accountId: string; required: boolean; version: string; url: string; acceptedAt: string | null }
export function validateTermsStatus(input: unknown, accountId: string): TermsStatus {
  const value = input as TermsStatus | null
  if (!value || value.accountId !== accountId || typeof value.required !== "boolean"
      || typeof value.version !== "string" || !/^\d{4}-\d{2}-\d{2}\.\d+$/.test(value.version)
      || value.url !== termsUrl || (value.acceptedAt !== null && (typeof value.acceptedAt !== "string" || !Number.isFinite(Date.parse(value.acceptedAt))))) {
    throw new Error("The terms confirmation did not match your account. Please try again.")
  }
  return { accountId, required: value.required, version: value.version, url: value.url, acceptedAt: value.acceptedAt }
}
