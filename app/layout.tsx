import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs"
import { NativeMobileBridge } from "@/components/native-mobile-bridge"
import { TaskSaveProvider } from "@/components/task-save-provider"
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Cyntch",
  description: "Shared tasks, family routines and little wins for the whole household.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider afterSignOutUrl="/" signInUrl="/auth/login" signUpUrl="/auth/signup" signInFallbackRedirectUrl="/app" signUpFallbackRedirectUrl="/app" appearance={{ variables: { colorPrimary: "#23685b", colorText: "#243e3b", borderRadius: "0.8rem", fontFamily: "var(--font-geist-sans), sans-serif" }, elements: { cardBox: "shadow-sm border border-border", formButtonPrimary: "shadow-none" } }}>
      <html
        lang="en"
        className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      >
        <body className="min-h-full flex flex-col">
          <NativeMobileBridge />
          <TaskSaveProvider>{children}</TaskSaveProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
