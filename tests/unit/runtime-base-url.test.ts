import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Hono } from 'hono'
import { contextStorage, getContext } from 'hono/context-storage'
import { RouterContextProvider, createRequestHandler, type LoaderFunction, type ServerBuild } from 'react-router'
import { libraryModeEnum } from '#@/databases/schema.ts'
import { auth } from '#@/middlewares/auth.ts'
import { baseUrl } from '#@/middlewares/base-url.ts'
import { loader as loginOidcLoader } from '#@/pages/routes/login-oidc.ts'
import { loader as loginLoader } from '#@/pages/routes/login.tsx'
import { loader as logoutLoader } from '#@/pages/routes/logout.ts'
import { withBasePath } from '#@/utils/isomorphic/base-url.ts'
import { getSafeRedirectTo, getSafeRouterRedirectTo } from '#@/utils/server/auth.ts'
import { getOidcCallbackUrl } from '#@/utils/server/oidc.ts'
import { configureRouterBuild } from '#@/utils/server/router-build.ts'
import { setSessionCookie } from '#@/utils/server/session.ts'
import { getWebManifest } from '#@/utils/server/webmanifest.ts'

function Page() {
  return null
}

function runtimeLoader({ request }: { request: Request }) {
  const url = new URL(request.url)
  if (url.pathname.endsWith('/redirect')) {
    return getContext().redirect(getSafeRouterRedirectTo(url.searchParams.get('redirect_to')))
  }
  return { appPath: getContext().var.appPath, pathname: url.pathname }
}

function createBuild(loader: LoaderFunction = runtimeLoader): ServerBuild {
  // React Router 8.4 still emits and requires this legacy build metadata.
  const legacyBuildMetadata = { isSpaMode: false }
  return {
    ...legacyBuildMetadata,
    assets: {
      entry: { imports: ['./assets/shared.js'], module: './assets/entry.js' },
      routes: {
        missing: undefined,
        root: {
          clientActionModule: undefined,
          clientLoaderModule: undefined,
          clientMiddlewareModule: undefined,
          css: ['./assets/styles.css'],
          hasAction: false,
          hasClientAction: false,
          hasClientLoader: false,
          hasClientMiddleware: false,
          hasErrorBoundary: false,
          hasLoader: true,
          hydrateFallbackModule: undefined,
          id: 'root',
          module: './assets/root.js',
        },
      },
      url: './assets/manifest.js',
      version: 'fixture',
    },
    assetsBuildDirectory: 'dist/client',
    basename: '/',
    entry: {
      module: {
        default(...[, status, headers, context]: Parameters<ServerBuild['entry']['module']['default']>) {
          return Response.json(
            {
              assets: context.manifest,
              basename: context.staticHandlerContext.basename,
              data: context.staticHandlerContext.loaderData,
            },
            { headers, status },
          )
        },
      },
    },
    future: {},
    prerender: [],
    publicPath: './',
    routeDiscovery: { manifestPath: '/__manifest', mode: 'lazy' },
    routes: {
      root: {
        id: 'root',
        module: {
          default: Page,
          loader,
        },
        path: '*',
      },
    },
    ssr: true,
  }
}

function createAuthenticatedApp(loader: LoaderFunction) {
  const handler = createRequestHandler(configureRouterBuild(createBuild(loader)), 'test')
  const app = new Hono()
  app.use(contextStorage())
  app.use(baseUrl())
  app.use(async function authenticated(c, next) {
    c.set('currentUser', { id: 'fixture-user', libraryMode: libraryModeEnum.isolated, username: 'fixture' })
    await next()
  })
  app.use(auth())
  app.all('*', function handleLoader(c) {
    return handler(c.req.raw, new RouterContextProvider())
  })
  return app
}

await describe('runtime server base-path contract', async () => {
  for (const basePath of ['/', '/games/retroassembly', '/assets']) {
    await it(`aligns SSR, route discovery, APIs and auth at ${basePath}`, async (t) => {
      t.mock.property(process, 'env', {
        ...process.env,
        BASE_URL: basePath,
        RETROASSEMBLY_RUN_TIME_OIDC_REDIRECT_URI: '',
      })
      const sourceBuild = createBuild()
      const build = configureRouterBuild(sourceBuild)
      const handler = createRequestHandler(build, 'test')
      const app = new Hono()
      app.use(contextStorage())
      app.use(baseUrl())
      app.use(auth())
      const api = new Hono().basePath('api/v1').get('files/:id', (c) => c.text(c.req.param('id')))
      app.route(basePath, api)
      app.get(withBasePath('/manifest.webmanifest'), (c) => c.json(getWebManifest()))
      app.get(withBasePath('/session'), (c) => {
        setSessionCookie('fixture-token', new Date(Date.now() + 60_000), false)
        return c.json({ callback: getOidcCallbackUrl() })
      })
      app.all('*', (c) => handler(c.req.raw, new RouterContextProvider()))

      const path = withBasePath('/demo/platform/nes/rom/Homebrew%20Pulse', basePath)
      const document = await app.request(path)
      assert.equal(document.status, 200)
      const body = await document.json()
      assert.partialDeepStrictEqual(body, {
        assets: {
          entry: { module: withBasePath('/assets/entry.js', basePath) },
          routes: { root: { css: [withBasePath('/assets/styles.css', basePath)] } },
        },
        basename: basePath,
        data: { root: { appPath: '/demo/platform/nes/rom/Homebrew Pulse', pathname: path } },
      })
      assert.equal(configureRouterBuild(build).assets.entry.module, build.assets.entry.module)
      assert.equal(sourceBuild.assets.entry.module, './assets/entry.js', 'Do not mutate a shared server build')
      const data = await app.request(`${path}.data`)
      assert.equal(data.status, 200)
      const dataBody = await data.text()
      assert.ok(dataBody.includes(path), 'Single-fetch loaders must see the configured public path')
      const manifest = await app.request(
        `${withBasePath('/__manifest', basePath)}?version=fixture&paths=${encodeURIComponent(path)}`,
      )
      assert.equal(manifest.status, 200)
      const routeManifest = await manifest.json()
      assert.partialDeepStrictEqual(routeManifest, { root: { module: withBasePath('/assets/root.js', basePath) } })
      const file = await app.request(withBasePath('/api/v1/files/Homebrew%20Pulse.nes', basePath))
      assert.equal(await file.text(), 'Homebrew Pulse.nes')

      const privatePath = withBasePath('/library/roms?sort=name', basePath)
      const anonymous = await app.request(privatePath)
      const login = new URL(anonymous.headers.get('Location') || '', 'http://localhost')
      assert.equal(anonymous.status, 302)
      assert.equal(login.pathname, withBasePath('/login', basePath))
      assert.equal(login.searchParams.get('redirect_to'), privatePath)
      assert.equal(getSafeRedirectTo(`${privatePath}#games`), `${privatePath}#games`)
      assert.equal(getSafeRedirectTo('//outside.example'), withBasePath('/library', basePath))
      const returnPath = `${privatePath}#games`
      const returned = await app.request(
        `${withBasePath('/redirect', basePath)}?redirect_to=${encodeURIComponent(returnPath)}`,
      )
      assert.equal(returned.status, 302)
      assert.equal(
        returned.headers.get('Location'),
        returnPath,
        'Loader redirects must prepend the basename exactly once',
      )
      const session = await app.request(withBasePath('/session', basePath), {
        headers: { 'X-Forwarded-Host': 'arcade.example', 'X-Forwarded-Proto': 'https' },
      })
      assert.ok(session.headers.get('Set-Cookie')?.includes(`Path=${basePath};`))
      const sessionBody = await session.json()
      assert.partialDeepStrictEqual(sessionBody, {
        callback: `https://arcade.example${withBasePath('/login/oidc/callback', basePath)}`,
      })
      const webmanifest = await app.request(withBasePath('/manifest.webmanifest', basePath))
      const installation = await webmanifest.json()
      assert.partialDeepStrictEqual(installation, {
        id: withBasePath('/?pwa_version=1', basePath),
        scope: withBasePath('/', basePath),
        start_url: withBasePath('/library', basePath),
      })

      if (basePath !== '/') {
        const canonical = await app.request(`${basePath}?sort=name`, { method: 'POST' })
        assert.equal(canonical.status, 308)
        assert.equal(canonical.headers.get('Location'), `${basePath}/?sort=name`)
        for (const sibling of ['/login', '/api/v1/files/game', `${basePath}2/demo`]) {
          const response = await app.request(sibling, { headers: { 'X-Forwarded-Prefix': basePath } })
          assert.equal(response.status, 404, sibling)
        }
        assert.equal(getSafeRedirectTo(`${basePath}/../library`), `${basePath}/library`)
        assert.equal(getSafeRedirectTo(`${basePath}2/library`), `${basePath}/library`)
      }
    })
  }

  for (const basePath of ['/', '/games/retroassembly', '/assets']) {
    await it(`contains real login loader redirects at ${basePath}`, async function containsLoginRedirects(t) {
      t.mock.property(process, 'env', {
        ...process.env,
        BASE_URL: basePath,
        RETROASSEMBLY_RUN_TIME_OIDC_CLIENT_ID: 'fixture',
        RETROASSEMBLY_RUN_TIME_OIDC_CLIENT_SECRET: 'fixture',
        RETROASSEMBLY_RUN_TIME_OIDC_ISSUER: 'https://id.example',
        RETROASSEMBLY_RUN_TIME_SUPABASE_ANON_KEY: '',
        RETROASSEMBLY_RUN_TIME_SUPABASE_URL: '',
      })
      const prefix = basePath === '/' ? '' : basePath
      const validReturn = `${prefix}/library/rom/Homebrew%20Pulse%2F1?sort=name%26region#saves%20latest`
      const returns = [
        { expected: `${prefix}/library`, value: `${prefix}//outside.example` },
        { expected: `${prefix}/library`, value: `${prefix}/return/..//outside.example?next=%2Flibrary#games` },
        { expected: validReturn, value: validReturn },
      ]
      for (const route of [
        { loader: loginLoader, path: '/login' },
        { loader: loginOidcLoader, path: '/login/oidc' },
      ]) {
        const app = createAuthenticatedApp(route.loader)
        for (const { expected, value } of returns) {
          const response = await app.request(`${prefix}${route.path}?redirect_to=${encodeURIComponent(value)}`)
          assert.equal(response.status, 302)
          const location = response.headers.get('Location')
          assert.ok(location)
          assert.equal(location, expected, `${route.path}: ${value}`)
          const target = new URL(location, 'http://localhost')
          assert.equal(target.origin, 'http://localhost')
          assert.ok(target.pathname.startsWith(`${prefix}/`))
        }
      }

      const logout = await createAuthenticatedApp(logoutLoader).request(
        `${prefix}/logout?redirect_to=${encodeURIComponent(`${prefix}//outside.example`)}`,
      )
      assert.equal(logout.status, 302)
      assert.equal(logout.headers.get('Location'), basePath)
    })
  }
})
