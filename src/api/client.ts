import { attemptAsync, isBrowser } from 'es-toolkit'
import { hc, parseResponse } from 'hono/client'
import { withBasePath } from '#@/utils/isomorphic/base-url.ts'
import type { AppType } from './app'

const baseUrl = new URL(withBasePath('/'), isBrowser() ? location.origin : 'http://localhost').href

export const client = hc<AppType>(baseUrl, {
  async fetch(...args: Parameters<typeof fetch>) {
    const response = await fetch(...args)
    if (response.ok) {
      return response
    }
    const [, json] = await attemptAsync(() => response.json())
    throw json ?? response
  },
}).api.v1
export type { InferRequestType, InferResponseType } from 'hono'
export { parseResponse }
