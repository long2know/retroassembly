import { Hono } from 'hono'
import { RouterContextProvider, createRequestHandler } from 'react-router'
import { getBasePath } from '#@/utils/isomorphic/base-url.ts'
import { getAuthMode } from '#@/utils/server/auth.ts'
import { createDrizzle } from '#@/utils/server/drizzle.ts'
import { initializeMountedLibrary } from '#@/utils/server/mounted-library.ts'
import { configureRouterBuild } from '#@/utils/server/router-build.ts'
import app from './app.ts'

getAuthMode()
await initializeMountedLibrary(createDrizzle().library)

const pages = new Hono()

pages.all('*', async (c) => {
  const build = await import('virtual:react-router/server-build')
  const requestHandler = createRequestHandler(configureRouterBuild(build), 'development')
  return requestHandler(c.req.raw, new RouterContextProvider())
})

if (app.router.name === 'SmartRouter') {
  app.route(getBasePath(), pages)
}

export { default } from './app.ts'
