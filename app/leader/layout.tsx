import { Suspense } from "react"
import { AppHeader } from "@/components/app-header"

export default function LeaderLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      <Suspense fallback={<div className="h-[var(--app-header-height)] shrink-0 border-b border-border/70 bg-card/90" />}>
        <AppHeader />
      </Suspense>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  )
}
