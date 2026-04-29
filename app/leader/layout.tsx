import { AppHeader } from "@/components/app-header"

export default function LeaderLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      <AppHeader />
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  )
}
