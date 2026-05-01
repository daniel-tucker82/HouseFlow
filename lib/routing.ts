import type { AppRole } from "@/lib/types"

export function roleToDashboard(role: AppRole) {
  return role === "manager" || role === "supervisor" || role === "leader" ? "/leader/dashboard" : "/member/dashboard"
}
