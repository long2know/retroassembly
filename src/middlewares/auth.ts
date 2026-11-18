import { createMiddleware } from 'hono/factory'
import { defaultRedirectTo } from '#@/constants/auth.ts'
import { withBasePath } from '#@/utils/isomorphic/base-url.ts'

export function auth() {
  return createMiddleware(async (c, next) => {
    const { currentUser } = c.var

    const { origin, pathname, search } = new URL(c.req.raw.url)
    const { appPath, basePath } = c.var
    const needAuth = ['/library', '/library.data'].includes(appPath) || appPath.startsWith('/library/')
    if (!needAuth || currentUser) {
      await next()
      return
    }

    const redirectTo = `${pathname}${search}`
    const loginUrl = new URL(withBasePath('/login', basePath), origin)
    if (redirectTo !== withBasePath(defaultRedirectTo, basePath)) {
      loginUrl.searchParams.set('redirect_to', redirectTo)
    }
    const loginUrlPath = `${loginUrl.pathname}${loginUrl.search}`

    return c.redirect(loginUrlPath)
  })
}
