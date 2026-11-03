import { SignIn } from "@clerk/nextjs"

type LoginPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams
  const nextParam = typeof params.next === "string" ? params.next : ""
  const forceRedirectUrl = nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : undefined

  return (
    <main className="flex w-full justify-center">
      <SignIn
        path="/auth/login"
        routing="path"
        signUpUrl="/auth/signup"
        forceRedirectUrl={forceRedirectUrl}
        fallbackRedirectUrl="/app"
      />
    </main>
  )
}
