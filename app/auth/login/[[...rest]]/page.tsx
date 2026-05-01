import { SignIn } from "@clerk/nextjs"

type LoginPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams
  const nextParam = typeof params.next === "string" ? params.next : ""
  const forceRedirectUrl = nextParam.startsWith("/") ? nextParam : undefined

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 items-center justify-center p-6">
      <SignIn
        path="/auth/login"
        routing="path"
        signUpUrl="/auth/signup"
        forceRedirectUrl={forceRedirectUrl}
      />
    </main>
  )
}
