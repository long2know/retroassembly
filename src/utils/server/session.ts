import { getContext } from 'hono/context-storage'
import { setCookie } from 'hono/cookie'
import { getBasePath } from '#@/utils/isomorphic/base-url.ts'
import { getRequestUrl } from './request-url.ts'

export function isSecureRequest() {
  return getRequestUrl().protocol === 'https:'
}

export function setSessionCookie(token: string, expires: Date, secure = isSecureRequest()) {
  const c = getContext()
  setCookie(c, 'token', token, {
    expires,
    httpOnly: true,
    path: getBasePath(),
    sameSite: 'Strict',
    secure,
  })
}
