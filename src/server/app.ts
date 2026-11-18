import { Hono } from 'hono'
import { contextStorage } from 'hono/context-storage'
import { app as api } from '#@/api/app.ts'
import { getRunTimeEnv } from '#@/constants/env.ts'
import { auth } from '#@/middlewares/auth.ts'
import { baseUrl } from '#@/middlewares/base-url.ts'
import { globals } from '#@/middlewares/globals.ts'
import { logger } from '#@/middlewares/logger.ts'
import { vendors } from '#@/middlewares/vendors.ts'
import { getBasePath, withBasePath } from '#@/utils/isomorphic/base-url.ts'
import { getWebManifest } from '#@/utils/server/webmanifest.ts'

const app = new Hono()
app.use(contextStorage())
app.use(baseUrl())
app.use(vendors(), globals(), auth(), logger())
app.route(getBasePath(), api)
app.get(withBasePath('/manifest.webmanifest'), (c) =>
  c.json(getWebManifest(), 200, { 'Content-Type': 'application/manifest+json' }),
)
app.get(withBasePath('/robots.txt'), (c) => {
  const allowCrawler = getRunTimeEnv().RETROASSEMBLY_RUN_TIME_ALLOW_CRAWLER === 'true'
  const allow = ['User-agent: *', 'Allow: /'].join('\n')
  const disallow = ['User-agent: *', 'Disallow: /'].join('\n')
  const content = allowCrawler ? allow : disallow
  return c.text(content)
})

export default app
