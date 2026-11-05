export interface HouseholdInvitation {
  id: string; code: string; expiresAt: string; maxUses: number; usesCount: number; createdAt: string;
  status: "available" | "expired" | "used";
}
export interface InvitationPage {
  accountId: string; householdId: string; items: HouseholdInvitation[]; nextCursor: string | null;
}

/** Matches the existing website invitation form. */
export function validInvitationLimits(maxUses: number, expiresInDays: number) {
  return Number.isInteger(maxUses) && maxUses >= 1 && maxUses <= 100 &&
    Number.isInteger(expiresInDays) && expiresInDays >= 1 && expiresInDays <= 365
}
export function invitationUrl(code: string) { return `https://www.cyntch.com/join/${encodeURIComponent(code)}` }
