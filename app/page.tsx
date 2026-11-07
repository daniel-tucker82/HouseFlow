import type { Metadata } from "next"
import Link from "next/link"
import {
  ArrowDown,
  ArrowRight,
  Bell,
  Check,
  ChevronDown,
  Gift,
  Heart,
  Repeat2,
  Users,
  Workflow,
} from "lucide-react"
import { Brand } from "@/components/brand"
import { RoutineDemo } from "@/components/marketing/routine-demo"

export const metadata: Metadata = {
  title: "Cyntch — A little less reminding. A lot more living.",
  description:
    "Bring household tasks, family routines and rewards together with Cyntch. Help everyone know what’s next and share the work of everyday life.",
  alternates: { canonical: "https://cyntch.com" },
  openGraph: {
    title: "Cyntch — Make everyday family life flow",
    description: "Shared tasks. Clear routines. Little wins for everyone.",
    url: "https://cyntch.com",
    siteName: "Cyntch",
    type: "website",
  },
}

const questions = [
  [
    "What is Cyntch?",
    "Cyntch is a shared space for household tasks and routines. Set out what needs doing, assign it to family members, and connect tasks so everyone can see what’s ready, what’s next, and what’s done.",
  ],
  [
    "How do routines and rewards work?",
    "Create a routine once and set a repeating schedule. Tasks can unlock after other tasks are completed or at a chosen time. Add a reward at the end to give everyone something to work towards.",
  ],
  [
    "Does every family member need an account?",
    "No. You can create member profiles for your household and show their tasks on a shared board. Use kiosk mode for a shared household device, or invite people to join with their own account.",
  ],
  [
    "Can we use it on a phone or tablet?",
    "Yes. Open Cyntch in your browser on a computer, phone or tablet. The member board keeps each person’s tasks together, and you can choose which family members appear on a shared screen.",
  ],
]

export default function HomePage() {
  return (
    <div className="marketing-page">
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <header className="marketing-nav">
        <Link href="/" aria-label="Cyntch home">
          <Brand />
        </Link>
        <nav
          aria-label="Main navigation"
          className="hidden items-center gap-8 text-sm text-muted-foreground md:flex"
        >
          <a href="#how-it-works" className="hover:text-primary">
            How it works
          </a>
          <a href="#benefits" className="hover:text-primary">
            Why Cyntch
          </a>
          <a href="#questions" className="hover:text-primary">
            FAQs
          </a>
        </nav>
        <div className="flex items-center gap-3 sm:gap-5">
          <Link href="/auth/login" className="text-sm font-medium hover:text-primary">
            Log in
          </Link>
          <Link href="/auth/signup" className="marketing-button small">
            Get started <ArrowRight className="size-4" />
          </Link>
        </div>
      </header>
      <main id="main-content">
        <section className="marketing-hero marketing-container">
          <div className="hero-copy">
            <p className="eyebrow">
              <span className="size-2 rounded-full bg-primary" /> A calmer kind of household
            </p>
            <h1>
              A little less
              <br />
              reminding.
              <br />
              <span>A lot more living.</span>
            </h1>
            <p className="hero-description">
              The morning rush. The everyday chores. The “have you done it yet?” Bring it all together with
              shared tasks, simple routines and little wins for the whole family.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-5">
              <Link href="/auth/signup" className="marketing-button">
                Make your home a Cyntch <ArrowRight className="size-4" />
              </Link>
              <a href="#how-it-works" className="inline-flex items-center gap-2 text-sm font-medium">
                Take a look <ArrowDown className="size-4" />
              </a>
            </div>
            <p className="mt-5 text-xs text-muted-foreground">
              Your household. Your routines. A little more breathing room.
            </p>
          </div>
          <div className="hero-preview">
            <div className="hero-preview-label">
              <Heart className="size-4" /> Small steps. Happier households.
            </div>
            <RoutineDemo />
            <div className="hero-preview-note">
              <span className="flex size-8 items-center justify-center rounded-full bg-[#e6f0d7]">
                <Check className="size-4 text-primary" />
              </span>
              <div>
                <strong>Less on your mind.</strong>
                <span>More of you in the moment.</span>
              </div>
            </div>
          </div>
        </section>
        <section className="benefit-strip" aria-label="At a glance">
          <div className="marketing-container grid gap-6 sm:grid-cols-3">
            {[
              { icon: Users, title: "Share the load", description: "Everyone has a part to play." },
              { icon: Repeat2, title: "Find your rhythm", description: "Routines you can come back to." },
              {
                icon: Gift,
                title: "Celebrate the little wins",
                description: "Progress worth looking forward to.",
              },
            ].map(({ icon: Icon, title, description }) => (
              <div key={title} className="flex items-center gap-4">
                <Icon className="size-6 shrink-0 text-primary" strokeWidth={1.5} />
                <div>
                  <h2 className="text-sm font-semibold">{title}</h2>
                  <p className="mt-1 text-xs text-muted-foreground">{description}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
        <section id="how-it-works" className="marketing-container marketing-section">
          <div className="section-heading">
            <p className="eyebrow">A rhythm that works for you</p>
            <h2>
              From “don’t forget”
              <br />
              to “already done”.
            </h2>
            <p>Make the everyday a little easier to follow. Start with one routine and build from there.</p>
          </div>
          <div className="steps-grid">
            {[
              {
                number: "01",
                icon: Users,
                title: "Bring everyone together",
                body: "Create your household and add your people. Give everyone their own space on the board, including kids without an account.",
              },
              {
                number: "02",
                icon: Workflow,
                title: "Give the day a little structure",
                body: "Add tasks, choose who does what, and connect the steps. Set routines to repeat so you don’t have to start from scratch.",
              },
              {
                number: "03",
                icon: Gift,
                title: "Make room for the good stuff",
                body: "See progress as tasks are checked off. Unlock a reward when the work is done, from game time to choosing a family activity.",
              },
            ].map(({ number, icon: Icon, title, body }) => (
              <article key={number} className="step">
                <div className="mb-7 flex items-center justify-between">
                  <span className="step-icon">
                    <Icon className="size-6" strokeWidth={1.5} />
                  </span>
                  <span className="text-xs font-medium text-muted-foreground">{number} /</span>
                </div>
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
        </section>
        <section id="benefits" className="marketing-container pb-24">
          <div className="together-section">
            <div>
              <p className="eyebrow">Less managing. More together.</p>
              <h2>
                A shared plan.
                <br />A clearer next step.
              </h2>
              <p className="mt-5 max-w-md text-[15px] leading-7 text-muted-foreground">
                You shouldn’t have to hold the whole household’s to-do list in your head. Give everyone a
                clear view of their part in the day.
              </p>
              <Link
                href="/auth/signup"
                className="mt-7 inline-flex items-center gap-2 text-sm font-semibold text-primary"
              >
                Find your family’s flow <ArrowRight className="size-4" />
              </Link>
            </div>
            <div className="space-y-7">
              {[
                {
                  icon: Check,
                  title: "Know what’s ready, and what can wait",
                  body: "Clear task states and dependencies help everyone take things one step at a time.",
                },
                {
                  icon: Users,
                  title: "One household, everyone in view",
                  body: "Individual task lanes keep responsibilities clear. Choose who appears on a shared tablet or household screen.",
                },
                {
                  icon: Bell,
                  title: "Keep up without checking in",
                  body: "Choose notifications for task updates, so you can stay in the loop as the day moves along.",
                },
              ].map(({ icon: Icon, title, body }) => (
                <div key={title} className="flex gap-4">
                  <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-white text-primary">
                    <Icon className="size-4" />
                  </span>
                  <div>
                    <h3 className="text-sm font-semibold">{title}</h3>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">{body}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
        <section id="questions" className="marketing-container faq-section">
          <div>
            <p className="eyebrow">A few things you might be wondering</p>
            <h2>
              A little more
              <br />
              about Cyntch.
            </h2>
          </div>
          <div>
            {questions.map(([question, answer]) => (
              <details key={question} className="faq-item">
                <summary>
                  {question}
                  <ChevronDown className="size-4 shrink-0 transition-transform" />
                </summary>
                <p>{answer}</p>
              </details>
            ))}
          </div>
        </section>
        <section className="marketing-container pb-8">
          <div className="final-cta">
            <span className="mb-6 inline-flex size-12 items-center justify-center rounded-2xl border border-white/20">
              <Heart className="size-6" strokeWidth={1.5} />
            </span>
            <h2>
              Make space for more
              <br />
              than the to-do list.
            </h2>
            <p>Start with your household. Find your rhythm together.</p>
            <Link href="/auth/signup" className="marketing-button light">
              Get started with Cyntch <ArrowRight className="size-4" />
            </Link>
            <span className="mt-5 block text-xs text-white/70">
              Already part of the family?{" "}
              <Link href="/auth/login" className="text-white underline underline-offset-4">
                Log in
              </Link>
            </span>
          </div>
        </section>
      </main>
      <footer className="marketing-container flex flex-wrap items-center justify-between gap-6 py-8">
        <Link href="/" aria-label="Cyntch home">
          <Brand />
        </Link>
        <p className="text-xs text-muted-foreground">A little more flow. A little more family.</p>
        <nav aria-label="Cyntch policies" className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
          <Link href="/legal/privacy" className="inline-flex min-h-11 items-center underline underline-offset-4 hover:text-primary">Privacy policy</Link>
          <Link href="/legal/terms" className="inline-flex min-h-11 items-center underline underline-offset-4 hover:text-primary">Terms of use</Link>
        </nav>
        <Link href="/auth/login" className="text-xs font-medium text-muted-foreground hover:text-primary">
          Log in to your household <ArrowRight className="ml-1 inline size-3" />
        </Link>
      </footer>
    </div>
  )
}
