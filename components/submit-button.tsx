"use client"

import { useFormStatus } from "react-dom"
import { ArrowRight, LoaderCircle } from "lucide-react"

export function SubmitButton({
  children,
  pendingLabel = "Saving…",
}: {
  children: React.ReactNode
  pendingLabel?: string
}) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
    >
      {pending ? (
        <>
          <LoaderCircle className="size-4 animate-spin" />
          {pendingLabel}
        </>
      ) : (
        <>
          {children}
          <ArrowRight className="size-4" />
        </>
      )}
    </button>
  )
}
