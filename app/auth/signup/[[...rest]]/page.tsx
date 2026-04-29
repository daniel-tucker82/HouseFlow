import { SignUp } from "@clerk/nextjs"

export default function SignUpPage() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 items-center justify-center p-6">
      <SignUp path="/auth/signup" routing="path" signInUrl="/auth/login" />
    </main>
  )
}
