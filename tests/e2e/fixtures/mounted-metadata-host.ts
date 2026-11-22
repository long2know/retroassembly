import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { serve } from '@hono/node-server'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import {
  atariCatalogTitles,
  atariProviderMetadata,
  catalogTitles,
  syntheticCatalog,
  syntheticCover,
} from './synthetic-catalog.ts'

const db = new Database(path.join(process.env.RETROASSEMBLY_RUN_TIME_DATA_DIRECTORY || '', 'retroassembly.sqlite'))
migrate(drizzle(db), { migrationsFolder: 'src/databases/migrations' })
db.prepare(
  'INSERT INTO mounted_library_settings (id, automatic_metadata, scan_interval_seconds, updated_at) VALUES (1, 0, 0, 0)',
).run()
db.close()

let mirrorRequests = 0
let atariCoverRequests = 0
function providerResponse(input: Parameters<typeof fetch>[0], init?: RequestInit) {
  const url = new URL(input instanceof Request ? input.url : input)
  const pathname = decodeURIComponent(url.pathname)
  process.send?.({ provider: url.origin })
  if (init?.redirect !== 'error') {
    return new Response(null, { status: 500 })
  }
  if (url.origin === 'https://metadata.fixture.invalid' && pathname.endsWith('/metadata/identify')) {
    if (typeof init.body === 'string' && init.body.includes('"platform":"atari7800"')) {
      return Response.json([atariProviderMetadata])
    }
    return Response.json([
      {
        launchbox: { name: 'Legacy Lantern' },
        libretro: { name: 'Legacy Lantern (World)', platform: 'Nintendo - Nintendo Entertainment System' },
      },
    ])
  }
  if (url.origin === 'https://raw.githubusercontent.com' && pathname.endsWith('/Atari - 7800.rdb')) {
    return new Response(syntheticCatalog('atari7800'), { headers: { 'Content-Type': 'application/octet-stream' } })
  }
  if (
    ['https://thumbnails.libretro.com', 'https://cdn.jsdelivr.net'].includes(url.origin) &&
    /\/Named_Boxarts\/Copper Circuit(?: \(.+\))?\.png$/u.test(pathname)
  ) {
    if (pathname.endsWith(`/${atariCatalogTitles.alternate}.png`)) {
      atariCoverRequests += 1
      return new Response(syntheticCover(atariCoverRequests), { headers: { 'Content-Type': 'image/png' } })
    }
    return new Response(null, { status: 404 })
  }
  if (
    url.origin === 'https://raw.githubusercontent.com' &&
    pathname.endsWith('/Nintendo - Nintendo Entertainment System.rdb')
  ) {
    return new Response(syntheticCatalog('nes'), { headers: { 'Content-Type': 'application/octet-stream' } })
  }
  if (url.origin === 'https://thumbnails.libretro.com' && pathname.endsWith(`/${catalogTitles.sequel}.png`)) {
    return new Response(null, { status: 404 })
  }
  if (url.origin === 'https://cdn.jsdelivr.net' && pathname.endsWith(`/${catalogTitles.sequel}.png`)) {
    mirrorRequests += 1
    return mirrorRequests > 1
      ? new Response(syntheticCover(mirrorRequests - 1), { headers: { 'Content-Type': 'image/png' } })
      : new Response(null, { status: 404 })
  }
  if (
    ['https://thumbnails.libretro.com', 'https://cdn.jsdelivr.net'].includes(url.origin) &&
    /\/Named_Boxarts\/Legacy Lantern(?: \(World\))?\.png$/u.test(pathname)
  ) {
    return new Response(null, { status: 404 })
  }
  return new Response(null, { status: 500 })
}

globalThis.fetch = (input, init) => Promise.resolve(providerResponse(input, init))

const { default: app } = await import(pathToFileURL(path.resolve('dist/src/server/node.js')).href)
serve({ ...app, hostname: '127.0.0.1', port: 0 }, ({ port }) => {
  process.send?.({ port })
})
