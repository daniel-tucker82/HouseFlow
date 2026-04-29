import type { AppRole } from "@/lib/types"

export function roleToDashboard(role: AppRole) {
  return role === "leader" ? "/leader/dashboard" : "/member/dashboard"
}
