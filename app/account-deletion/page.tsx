import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { connection } from "next/server"
import { Brand } from "@/components/brand"
import { accountDeletionContact } from "@/lib/account-deletion-contact"

export const metadata: Metadata = {
  title: "Request account deletion | Cyntch",
  description: "Request deletion of your Cyntch account and associated data, even if you no longer have the app.",
  alternates: { canonical: "https://www.cyntch.com/account-deletion" },
}

export default async function AccountDeletionPage() {
  await connection()
  const contact = accountDeletionContact()
  if (!contact) notFound()
  return <div className="min-h-screen bg-background text-foreground">
    <a href="#deletion-request" className="skip-link">Skip to deletion request</a>
    <header className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-5 py-6 sm:px-8">
      <Link href="/" aria-label="Cyntch home"><Brand /></Link>
      <Link href="/" className="text-sm font-medium text-primary underline underline-offset-4">Back to Cyntch</Link>
    </header>
    <main id="deletion-request" className="mx-auto max-w-3xl space-y-8 px-5 pb-16 pt-6 sm:px-8">
      <section className="space-y-4">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Request account deletion</h1>
        <p className="text-lg text-muted-foreground">You can request deletion of your Cyntch account and associated data here. You do not need to install or reopen the mobile app.</p>
        <div className="space-y-4 rounded-2xl border border-border bg-card p-5 sm:p-6">
          <h2 className="text-xl font-semibold">Email Cyntch support</h2>
          <p>Send your request from the email address associated with your Cyntch account, if you still have access to it. Say that you want to delete your account. Do not send passwords, sign-in codes or payment card details.</p>
          <a href={contact.href} className="inline-flex min-h-12 items-center justify-center rounded-xl bg-primary px-5 py-3 text-center font-semibold text-primary-foreground">Request account deletion by email</a>
          <p className="break-all text-sm text-muted-foreground">If your email app does not open, write to <a className="underline underline-offset-4" href={contact.href}>{contact.email}</a>.</p>
          <p className="text-sm text-muted-foreground">We will verify account ownership and confirm your household choices before accepting deletion. If you cannot access the original email address, explain that in your request so we can help verify your identity.</p>
        </div>
      </section>
      <section className="space-y-3" aria-labelledby="what-is-removed">
        <h2 id="what-is-removed" className="text-xl font-semibold">What deletion removes</h2>
        <p>Your sign-in, household memberships, invitations, preferences and notification history are removed. Routines, runs and tasks you created are removed, including your content in shared households.</p>
        <p>If you own a household, we will confirm whether to delete it for everyone or transfer ownership to another eligible parent. Deleting a household also removes its tasks and routines. Profiles without their own sign-in are removed when no other household uses them.</p>
        <p>Other members’ own content is preserved where their household continues. Some transaction records and minimal deletion records are retained to prevent duplicate purchases, repeated requests or restoration of deleted data.</p>
      </section>
      <section className="space-y-3" aria-labelledby="subscriptions">
        <h2 id="subscriptions" className="text-xl font-semibold">Subscriptions</h2>
        <p>Deleting your account does not cancel Apple or Google Play subscriptions. Cancel store renewals separately to stop future charges. You can still request account deletion while doing this.</p>
        <ul className="list-disc space-y-3 pl-5">
          <li><a href="https://apps.apple.com/account/subscriptions" className="font-medium text-primary underline underline-offset-4">Manage Apple subscriptions</a></li>
          <li><a href="https://play.google.com/store/account/subscriptions" className="font-medium text-primary underline underline-offset-4">Manage Google Play subscriptions</a></li>
        </ul>
        <p>For households you own, Cyntch closes your website billing customer and stops its subscriptions during deletion processing. A transferred household keeps any remaining verified paid access; its new owner will need their own billing arrangement afterward.</p>
      </section>
      <section className="space-y-3" aria-labelledby="in-app">
        <h2 id="in-app" className="text-xl font-semibold">You can also request deletion in the app</h2>
        <p>Open Settings, choose Review account deletion, and follow the account, household and subscription review. Parent access and an internet connection are required. An accepted deletion request is permanent and cannot be cancelled.</p>
      </section>
    </main>
  </div>
}
