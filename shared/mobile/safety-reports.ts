import { notificationUuid } from "./notification-settings"

export type SafetyReportKind = "content" | "member" | "other"
export interface SafetyReportDraft { id: string; householdId: string; kind: SafetyReportKind; subject: string; message: string }
export interface SafetyReportReceipt { accountId: string; householdId: string; id: string; receivedAt: string }
export class SafetyReportError extends Error { constructor(message: string, public status = 400) { super(message) } }

export function parseSafetyDraft(input: unknown): SafetyReportDraft {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new SafetyReportError("Enter a report.")
  const value = input as Record<string, unknown>
  if (typeof value.id !== "string" || !notificationUuid.test(value.id)
      || typeof value.householdId !== "string" || !notificationUuid.test(value.householdId)
      || typeof value.kind !== "string" || !["content", "member", "other"].includes(value.kind)
      || typeof value.subject !== "string" || value.subject.length > 200
      || typeof value.message !== "string" || value.message.length > 2000) {
    throw new SafetyReportError("Name the content or person (2–200 characters) and describe your concern (10–2,000 characters).")
  }
  return { id: value.id.toLowerCase(), householdId: value.householdId.toLowerCase(), kind: value.kind as SafetyReportKind,
    subject: value.subject, message: value.message }
}

export function parseSafetyReport(input: unknown): SafetyReportDraft {
  const draft = parseSafetyDraft(input)
  if (draft.subject.trim().length < 2 || draft.message.trim().length < 10) throw new SafetyReportError("Name the content or person (at least 2 characters) and describe your concern (at least 10 characters).")
  return { ...draft, subject: draft.subject.trim(), message: draft.message.trim() }
}

export function parseSafetyReceipt(input: unknown, accountId: string, draft: SafetyReportDraft): SafetyReportReceipt {
  const value = input as SafetyReportReceipt | null
  if (!value || value.accountId !== accountId || value.householdId !== draft.householdId || value.id !== draft.id
      || typeof value.id !== "string" || !notificationUuid.test(value.id)
      || typeof value.householdId !== "string" || !notificationUuid.test(value.householdId)
      || typeof value.receivedAt !== "string" || !Number.isFinite(Date.parse(value.receivedAt))) {
    throw new Error("The report confirmation did not match. Your saved report is kept for another attempt.")
  }
  return { accountId, householdId: value.householdId, id: value.id, receivedAt: value.receivedAt }
}
