import { AppHeader } from "@/components/app-header"

export default function JoinLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <AppHeader />
      <div className="flex flex-1 flex-col">{children}</div>
    </div>
  )
}
