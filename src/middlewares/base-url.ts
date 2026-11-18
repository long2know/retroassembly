import { createMiddleware } from 'hono/factory'
import { getBasePath, stripBasePath } from '#@/utils/isomorphic/base-url.ts'

declare module 'hono' {
  interface ContextVariableMap {
    appPath: string
    basePath: string
  }
}

export function baseUrl(basePath = getBasePath()) {
  return createMiddleware(async (c, next) => {
    const appPath = stripBasePath(c.req.path, basePath)
    if (appPath === undefined) {
      return c.notFound()
    }
    if (basePath !== '/' && c.req.path === basePath) {
      return c.redirect(`${basePath}/${new URL(c.req.url).search}`, 308)
    }
    c.set('appPath', appPath)
    c.set('basePath', basePath)
    await next()
  })
}
