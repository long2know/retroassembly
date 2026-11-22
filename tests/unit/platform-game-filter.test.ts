import assert from 'node:assert/strict'
import { it, type TestContext } from 'node:test'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { Hono } from 'hono'
import { contextStorage } from 'hono/context-storage'
import { RouterContextProvider } from 'react-router'
import { defaultPreference } from '#@/constants/preference.ts'
import * as schema from '#@/databases/schema.ts'
import { favoriteTable, libraryModeEnum, romTable, statusEnum } from '#@/databases/schema.ts'
import { loader } from '#@/pages/routes/library-platform.tsx'
import { i18n } from '#@/utils/isomorphic/i18n.ts'

function fixture(t: TestContext) {
  const sqlite = new Database(':memory:')
  t.after(() => sqlite.close())
  const library = drizzle(sqlite, { casing: 'snake_case', schema })
  migrate(library, { migrationsFolder: 'src/databases/migrations' })

  const pattern = '/library/platform/:platform'
  const app = new Hono()
    .use(contextStorage())
    .use(async (c, next) => {
      c.set('currentUser', { id: 'owner', libraryMode: libraryModeEnum.isolated, username: 'owner' })
      c.set('db', { library })
      c.set('effectiveLibraryUserId', 'owner')
      c.set('preference', defaultPreference)
      c.set('t', i18n.t)
      await next()
    })
    .get(pattern, async (c) =>
      c.json(
        await loader({
          context: new RouterContextProvider(),
          params: { platform: c.req.param('platform') },
          pattern,
          request: c.req.raw,
          url: new URL(c.req.url),
        }),
      ),
    )

  async function list(params: Record<string, string> = {}, platform = 'nes') {
    const response = await app.request(`/library/platform/${platform}?${new URLSearchParams(params)}`)
    assert.equal(response.status, 200, await response.clone().text())
    const result: Awaited<ReturnType<typeof loader>> = await response.json()
    return { ...result, names: result.roms.map(({ fileName }) => fileName) }
  }

  return { library, list }
}

await it('matches the whole platform before counting and paginating, with favorite and sort constraints', async (t) => {
  const { library, list } = fixture(t)
  const files = Array.from({ length: 101 }, (_, index) => ({
    fileId: `shelf-${index}`,
    fileName: `Shelf ${String(index).padStart(3, '0')}.nes`,
    gameName: index === 100 ? 'Café [*?] Comet' : null,
    id: `shelf-${index}`,
    platform: 'nes' as const,
    userId: 'owner',
  }))
  const last = files.at(-1)
  assert.ok(last)
  await library.insert(romTable).values(files)
  await library.insert(favoriteTable).values([
    { romId: last.id, userId: 'owner' },
    { romId: files[0].id, userId: 'owner' },
    { romId: files[1].id, userId: 'different-user' },
  ])

  const unfiltered = await list()
  assert.equal(unfiltered.roms.length, 100)
  assert.ok(!unfiltered.names.includes(last.fileName))
  const title = await list({ filter: '  CAFÉ [*?] COMET  ' })
  assert.deepEqual(title.names, [last.fileName])
  assert.equal(title.gameFilter, 'CAFÉ [*?] COMET')
  assert.deepEqual(title.pagination, { current: 1, pages: 1, size: 100, total: 1 })

  const secondPage = await list({ filter: 'sHeLf', page: '2', sort: 'name' })
  assert.deepEqual(secondPage.names, [last.fileName])
  assert.deepEqual(secondPage.pagination, { current: 2, pages: 2, size: 100, total: 101 })
  const favorites = await list({ direction: 'desc', favorite: '1', filter: 'Shelf', sort: 'name' })
  assert.deepEqual(favorites.names, [last.fileName, files[0].fileName])
  assert.equal(favorites.pagination.total, 2)
  const cleared = await list({ filter: '  ', query: 'ignored global search' })
  assert.deepEqual(cleared.names, unfiltered.names)
})

await it('matches literal punctuation and respects user, status, mount and platform visibility', async (t) => {
  const { library, list } = fixture(t)
  const env = 'RETROASSEMBLY_RUN_TIME_ENABLE_SHARED_ROM_LIBRARY'
  const initialValue = process.env[env]
  t.after(() => {
    if (initialValue === undefined) {
      delete process.env[env]
    } else {
      process.env[env] = initialValue
    }
  })
  process.env[env] = 'true'

  const ownedRom = {
    fileId: 'owned',
    fileName: 'Literal %_.nes',
    id: 'owned',
    platform: 'nes',
    userId: 'owner',
  } as const
  const mountedSource = { available: true, metadata: 'disabled', path: 'Literal %_.nes', revision: 'test' } as const
  await library.insert(romTable).values([
    ownedRom,
    { ...ownedRom, fileName: 'Wildcard impostor.nes', id: 'impostor' },
    { ...ownedRom, id: 'other-user', userId: 'different-user' },
    { ...ownedRom, id: 'other-platform', platform: 'psx' },
    { ...ownedRom, id: 'deleted', status: statusEnum.deleted },
    { ...ownedRom, fileId: 'mounted', id: 'mounted', mountedSource, userId: null },
    {
      ...ownedRom,
      fileId: 'unavailable',
      id: 'unavailable',
      mountedSource: { ...mountedSource, available: false },
      userId: null,
    },
    {
      ...ownedRom,
      fileName: 'arcade-code.zip',
      id: 'arcade',
      platform: 'arcade',
      rawGameMetadata: { libretro: { name: 'Amoeba Fighters' } },
    },
  ])

  const punctuation = await list({ filter: '%_' })
  assert.deepEqual(punctuation.roms.map(({ id }) => id).toSorted(), ['mounted', 'owned'])
  assert.equal(punctuation.pagination.total, 2)
  const sqlLikeText = await list({ filter: "' OR 1=1 --" })
  assert.deepEqual(sqlLikeText.names, [])
  assert.deepEqual(sqlLikeText.pagination, { current: 1, pages: 0, size: 100, total: 0 })
  const arcade = await list({ filter: 'AMOEBA fighters' }, 'arcade')
  assert.deepEqual(arcade.names, ['arcade-code.zip'])
  const overlong = await list({ filter: 'a'.repeat(1000) })
  assert.equal(overlong.gameFilter.length, 128)
})
