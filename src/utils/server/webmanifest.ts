import { getBasePath, withBasePath } from '#@/utils/isomorphic/base-url.ts'

export function getWebManifest(basePath = getBasePath()) {
  function icon(filename: string, purpose?: string) {
    const size = filename.includes('192') ? '192x192' : '512x512'
    return {
      ...(purpose ? { purpose } : {}),
      sizes: size,
      src: withBasePath(`/assets/logo/${filename}`, basePath),
      type: 'image/png',
    }
  }
  return {
    background_color: '#be123c',
    description: 'The personal retro game collection cabinet in your browser',
    display: 'standalone',
    icons: [icon('logo-192x192.png'), icon('logo-512x512.png', 'any'), icon('maskable-512x512.png', 'maskable')],
    id: withBasePath('/?pwa_version=1', basePath),
    lang: 'en',
    name: 'RetroAssembly',
    scope: withBasePath('/', basePath),
    short_name: 'RetroAssembly',
    start_url: withBasePath('/library', basePath),
    theme_color: '#be123c',
  }
}
