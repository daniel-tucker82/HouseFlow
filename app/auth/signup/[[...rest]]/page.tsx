import { SignUp } from "@clerk/nextjs"

export default function SignUpPage() {
  return (
    <main className="flex w-full justify-center">
      <SignUp path="/auth/signup" routing="path" signInUrl="/auth/login" fallbackRedirectUrl="/app" />
    </main>
  )
}
