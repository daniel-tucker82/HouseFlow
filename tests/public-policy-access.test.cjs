/* eslint-disable @typescript-eslint/no-require-imports -- Exercise the deployed middleware module with a local Clerk boundary. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { join } = require('node:path')
const Module = require('node:module')
const { buildSync } = require('esbuild')

test('only the three public information pages skip Clerk; household routes still require sign-in', async () => {
  const clerk = require('@clerk/nextjs/server')
  const delegated = [], protectedPaths = []
  const mocks = {
    '@clerk/nextjs/server': {
      createRouteMatcher: clerk.createRouteMatcher,
      clerkMiddleware: handler => (request, event) => {
        delegated.push(request.nextUrl.pathname)
        return handler({ protect: () => protectedPaths.push(request.nextUrl.pathname) }, request, event)
      },
    },
  }
  const compiled = new Module(__filename, module)
  compiled.require = name => mocks[name] ?? require(name)
  compiled._compile(buildSync({ entryPoints: [join(__dirname, '../middleware.ts')],
    platform: 'node', format: 'cjs', bundle: true, packages: 'external', write: false }).outputFiles[0].text, __filename)
  const { NextRequest } = require('next/server')
  const visit = path => compiled.exports.default(new NextRequest('https://www.cyntch.com' + path), {})
  for (const path of ['/account-deletion', '/legal/privacy', '/legal/terms']) {
    assert.equal((await visit(path)).headers.get('x-middleware-next'), '1')
  }
  assert.deepEqual(delegated, [])
  const privatePaths = ['/app', '/leader/settings', '/member', '/join/example']
  const otherPaths = ['/account-deletion/extra', '/legal/privacy-copy', '/legal/terms/extra', '/api/mobile/account-deletion']
  for (const path of [...privatePaths, ...otherPaths]) await visit(path)
  assert.deepEqual(delegated, [...privatePaths, ...otherPaths])
  assert.deepEqual(protectedPaths, privatePaths)
})
