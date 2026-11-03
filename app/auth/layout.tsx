import Link from "next/link"
import { ArrowLeft, Check } from "lucide-react"
import { Brand } from "@/components/brand"

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-layout">
      <aside className="auth-story">
        <Link href="/" aria-label="Cyntch home">
          <Brand />
        </Link>
        <div className="py-12">
          <p className="eyebrow">A little more flow. A little more family.</p>
          <h1>
            Good days start
            <br />
            with a little
            <br />
            <span className="text-primary">less to remember.</span>
          </h1>
          <p className="max-w-sm text-sm leading-7 text-muted-foreground">
            Shared tasks, familiar routines and small celebrations. Bring your household together, one little
            win at a time.
          </p>
          <div className="mt-8 space-y-4">
            {[
              "A clear next step for everyone",
              "Routines that fit your family",
              "Rewards to look forward to",
            ].map((text) => (
              <p key={text} className="flex items-center gap-3 text-sm">
                <Check className="size-4 text-primary" />
                {text}
              </p>
            ))}
          </div>
        </div>
        <Link href="/" className="flex items-center gap-2 text-xs text-muted-foreground">
          <ArrowLeft className="size-3" /> Back to Cyntch
        </Link>
      </aside>
      <div className="auth-form">
        <Link href="/" aria-label="Cyntch home" className="mb-3 md:hidden">
          <Brand />
        </Link>
        {children}
        <Link href="/" className="text-xs text-muted-foreground hover:text-primary md:hidden">
          Back to homepage
        </Link>
      </div>
    </div>
  )
}
