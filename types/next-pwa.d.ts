declare module "next-pwa" {
  import type { NextConfig } from "next"

  type PWAConfig = {
    dest: string
    disable?: boolean
    register?: boolean
    skipWaiting?: boolean
    customWorkerDir?: string
    swSrc?: string
  }

  export default function withPWA(config: PWAConfig): (nextConfig: NextConfig) => NextConfig
}
