export interface HouseholdDeletionReceipt {
  id: string; householdId: string; state: "pending" | "completed"; createdAt: string; completedAt: string | null;
}
