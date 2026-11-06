import type { ReactNode } from "react"
import Link from "next/link"
import { Brand } from "@/components/brand"

export function PolicyPage({ title, intro, children }: { title: string; intro: string; children: ReactNode }) {
  return <div className="min-h-screen bg-background text-foreground">
    <a href="#policy" className="skip-link">Skip to {title.toLowerCase()}</a>
    <header className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-4 px-5 py-6 sm:px-8">
      <Link href="/" aria-label="Cyntch home"><Brand /></Link>
      <Link href="/" className="text-sm font-medium text-primary underline underline-offset-4">Back to Cyntch</Link>
    </header>
    <main id="policy" className="mx-auto max-w-3xl space-y-8 break-words px-5 pb-12 pt-6 leading-relaxed sm:px-8 [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4 [&_h2]:text-xl [&_h2]:font-semibold [&_li]:pl-1 [&_section]:space-y-3 [&_ul]:list-disc [&_ul]:space-y-3 [&_ul]:pl-5">
      <section>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
        <p className="text-sm text-muted-foreground">Last updated: <time dateTime="2026-11-06">6 November 2026</time></p>
        <p className="text-lg">{intro}</p>
      </section>
      {children}
    </main>
    <footer className="mx-auto w-full max-w-3xl px-5 pb-10 sm:px-8">
      <nav aria-label="Cyntch policies" className="flex flex-wrap gap-x-6 gap-y-3 border-t border-border pt-6 text-sm font-medium text-primary underline underline-offset-4">
        <Link className="inline-flex min-h-11 items-center" href="/legal/privacy">Privacy policy</Link>
        <Link className="inline-flex min-h-11 items-center" href="/legal/terms">Terms of use</Link>
      </nav>
    </footer>
  </div>
}
