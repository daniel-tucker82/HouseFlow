import { SignIn } from "@clerk/nextjs"

export default function LoginPage() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 items-center justify-center p-6">
      <SignIn path="/auth/login" routing="path" signUpUrl="/auth/signup" />
    </main>
  )
}
