import { cn } from "@/lib/utils"

export function Brand({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="m4 10 8-6 8 6v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8Z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
          <path
            d="m8.5 13.5 2.5 2.5 4.5-5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      {!compact && (
        <span className="text-[23px] font-bold tracking-[-0.06em]">
          cyntch<span className="text-primary">.</span>
        </span>
      )}
    </span>
  )
}
