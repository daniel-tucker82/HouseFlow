import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server"
import { NextResponse, type NextRequest, type NextFetchEvent } from "next/server"

const isProtectedRoute = createRouteMatcher([
  "/app(.*)",
  "/leader(.*)",
  "/member(.*)",
  "/join(.*)",
])

const withClerk = clerkMiddleware(
  async (auth, req) => {
    if (isProtectedRoute(req)) {
      await auth.protect()
    }
  },
  {
    signInUrl: "/auth/login",
    signUpUrl: "/auth/signup",
    // Preview Clerk requests use /__clerk; the SDK forwards them with its
    // authenticated proxy headers while production retains its existing DNS setup.
    frontendApiProxy: { enabled: process.env.VERCEL_ENV === "preview" },
  },
)

export default function middleware(request: NextRequest, event: NextFetchEvent) {
  // These exact routes authenticate their own recovery key or cron secret.
  // A deleted identity, stale cookie or provider outage must not gate durable
  // recovery. Each cron handler verifies its secret before starting any work.
  if (["/api/mobile/account-deletion/status", "/api/internal/account-deletions", "/api/internal/notifications", "/api/cron", "/api/internal/recurrence"].includes(request.nextUrl.pathname)) return NextResponse.next()
  return withClerk(request, event)
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
}
