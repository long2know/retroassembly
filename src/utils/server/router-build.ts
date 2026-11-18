import type { ServerBuild } from 'react-router'
import { getBasePath, withBasePath } from '#@/utils/isomorphic/base-url.ts'

export function configureRouterBuild(build: ServerBuild, basePath = getBasePath()): ServerBuild {
  if (build.routeDiscovery.mode !== 'lazy') {
    throw new Error('Runtime BASE_URL requires lazy React Router route discovery')
  }
  function assetUrl(value: string) {
    if (
      build.publicPath.startsWith('/') &&
      !build.publicPath.startsWith('//') &&
      !value.startsWith('//') &&
      value.startsWith(build.publicPath)
    ) {
      return withBasePath(value.slice(build.publicPath.length), basePath)
    }
    return withBasePath(value, basePath)
  }
  const { assets } = build
  const routes: ServerBuild['assets']['routes'] = {}
  for (const [id, route] of Object.entries(assets.routes)) {
    if (!route) {
      continue
    }
    routes[id] = {
      ...route,
      clientActionModule: route.clientActionModule ? assetUrl(route.clientActionModule) : undefined,
      clientLoaderModule: route.clientLoaderModule ? assetUrl(route.clientLoaderModule) : undefined,
      clientMiddlewareModule: route.clientMiddlewareModule ? assetUrl(route.clientMiddlewareModule) : undefined,
      css: route.css?.map(assetUrl),
      hydrateFallbackModule: route.hydrateFallbackModule ? assetUrl(route.hydrateFallbackModule) : undefined,
      imports: route.imports?.map(assetUrl),
      module: assetUrl(route.module),
    }
  }
  return {
    ...build,
    assets: {
      ...assets,
      entry: {
        ...assets.entry,
        imports: assets.entry.imports.map(assetUrl),
        module: assetUrl(assets.entry.module),
      },
      hmr: assets.hmr ? { ...assets.hmr, runtime: assetUrl(assets.hmr.runtime) } : undefined,
      routes,
      sri:
        typeof assets.sri === 'object'
          ? Object.fromEntries(
              Object.entries(assets.sri).map(function integrity([url, digest]) {
                return [assetUrl(url), digest]
              }),
            )
          : assets.sri,
      url: assetUrl(assets.url),
    },
    basename: basePath,
    publicPath: withBasePath('/', basePath),
  }
}
