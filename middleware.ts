import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server"

const isProtectedRoute = createRouteMatcher([
  "/app(.*)",
  "/leader(.*)",
  "/member(.*)",
  "/join(.*)",
])

export default clerkMiddleware(
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

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
}
