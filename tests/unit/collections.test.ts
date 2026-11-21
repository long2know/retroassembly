import assert from 'node:assert/strict'
import { it, type TestContext } from 'node:test'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { Hono } from 'hono'
import { contextStorage } from 'hono/context-storage'
import { z } from 'zod'
import { app as api } from '#@/api/app.ts'
import { defaultPreference } from '#@/constants/preference.ts'
import { getCollectionGames, listCollections } from '#@/controllers/collections/collections.ts'
import * as schema from '#@/databases/schema.ts'
import { gameCollectionRomTable, libraryModeEnum, romTable, statusEnum } from '#@/databases/schema.ts'

const endpoint = '/api/v1/collections'
const collectionDetail = z.object({
  pagination: z.object({ total: z.number() }),
  roms: z.array(z.object({ id: z.string(), platform: z.string() })),
})
const accounts = {
  owner: { effectiveId: 'owner', id: 'owner', libraryMode: libraryModeEnum.isolated, username: 'owner' },
  reader: { effectiveId: 'owner', id: 'reader', libraryMode: libraryModeEnum.shared, username: 'reader' },
  stranger: { effectiveId: 'stranger', id: 'stranger', libraryMode: libraryModeEnum.isolated, username: 'stranger' },
}

async function expectStatus(pending: Promise<Response>, expected: number) {
  const response = await pending
  assert.equal(response.status, expected, await response.clone().text())
  return response
}

function fixture(t: TestContext) {
  const sqlite = new Database(':memory:')
  t.after(() => sqlite.close())
  const library = drizzle(sqlite, { casing: 'snake_case', schema })
  migrate(library, { migrationsFolder: 'src/databases/migrations' })
  const app = new Hono()
    .use(contextStorage())
    .use(async (c, next) => {
      const actor = Object.values(accounts).find(({ id }) => id === c.req.header('fixture-account'))
      if (actor) {
        c.set('currentUser', actor)
        c.set('effectiveLibraryUserId', actor.effectiveId)
        c.set('preference', { ...defaultPreference, ui: { ...defaultPreference.ui, platforms: ['nes'] } })
      }
      c.set('db', { library })
      c.set('unauthorized', !actor)
      await next()
    })
    .get('/lists', async (c) => c.json(await listCollections()))
    .get('/lists/:id', async (c) => {
      const result = await getCollectionGames(c.req.param('id'), 1)
      return result ? c.json(result) : c.json(null, 404)
    })
    .route('', api)

  async function request(
    user: keyof typeof accounts | null,
    path: string,
    { method = 'GET', value }: { method?: string; value?: unknown } = {},
  ) {
    const headers = new Headers()
    if (user) {
      headers.set('fixture-account', user)
    }
    if (value !== undefined) {
      headers.set('Content-Type', 'application/json')
    }
    return await app.request(path, { body: JSON.stringify(value), headers, method })
  }

  async function create(user: keyof typeof accounts, name: string) {
    const response = await expectStatus(request(user, endpoint, { method: 'POST', value: { name } }), 201)
    return z.object({ id: z.string(), name: z.string() }).parse(await response.json())
  }

  async function read(user: keyof typeof accounts, path = '/lists') {
    const response = await expectStatus(request(user, path), 200)
    return await response.json()
  }

  return { create, library, read, request, sqlite }
}

await it('validates names, handles duplicate writes and authorizes by the signed-in account', async (t) => {
  const { create, read, request } = fixture(t)
  const anonymous = await expectStatus(request(null, endpoint, { method: 'POST', value: { name: 'Private' } }), 401)
  assert.equal(anonymous.headers.get('Cache-Control'), 'private, no-store')

  for (const name of ['   ', 'a'.repeat(61), 'two\nlines', 42]) {
    await expectStatus(request('owner', endpoint, { method: 'POST', value: { name } }), 400)
  }

  const cafe = await create('owner', '  Café games  ')
  assert.equal(cafe.name, 'Café games')
  const duplicate = await expectStatus(
    request('owner', endpoint, { method: 'POST', value: { name: '  CAFE\u0301 GAMES  ' } }),
    409,
  )
  assert.deepEqual(await duplicate.json(), { code: 'duplicateName' })
  const parallel = await Promise.all(
    ['Weekend picks', 'weekend picks'].map((name) => request('owner', endpoint, { method: 'POST', value: { name } })),
  )
  assert.deepEqual(
    parallel.map((result) => result.status).toSorted((a, b) => a - b),
    [201, 409],
  )

  const readerCollection = await create('reader', 'Café games')
  assert.notEqual(readerCollection.id, cafe.id)
  assert.deepEqual(await read('reader'), [{ ...readerCollection, total: 0 }])
  await expectStatus(request('reader', `/lists/${cafe.id}`), 404)
  for (const [method, path, value] of [
    ['PATCH', `${endpoint}/${cafe.id}`, { name: 'Guess' }],
    ['DELETE', `${endpoint}/${cafe.id}`],
    ['PUT', `${endpoint}/${cafe.id}/roms/guessed`],
    ['DELETE', `${endpoint}/${cafe.id}/roms/guessed`],
  ] as const) {
    const result = await expectStatus(request('reader', path, { method, value }), 404)
    assert.equal(result.headers.get('Cache-Control'), 'private, no-store')
    assert.deepEqual(await result.json(), { message: 'Collection not found' })
  }
  const cafePath = `${endpoint}/${cafe.id}`
  await expectStatus(request('owner', cafePath, { method: 'PATCH', value: { name: ' ' } }), 400)
  await expectStatus(request('owner', cafePath, { method: 'PATCH', value: { name: 'weekend picks' } }), 409)
  const renamed = await expectStatus(
    request('owner', cafePath, { method: 'PATCH', value: { name: '  CAFÉ GAMES  ' } }),
    200,
  )
  assert.deepEqual(await renamed.json(), { id: cafe.id, name: 'CAFÉ GAMES' })
  await expectStatus(request('owner', cafePath, { method: 'DELETE' }), 200)
  await expectStatus(request('owner', `/lists/${cafe.id}`), 404)
  const recreated = await create('owner', 'café games')
  assert.notEqual(recreated.id, cafe.id)
})

await it('tracks visible ROM IDs across platforms and library modes without changing the ROMs', async (t) => {
  const { create, library, read, request } = fixture(t)
  const enabled = 'RETROASSEMBLY_RUN_TIME_ENABLE_SHARED_ROM_LIBRARY'
  const only = 'RETROASSEMBLY_RUN_TIME_SHARED_LIBRARY_ONLY'
  const originalEnv = { [enabled]: process.env[enabled], [only]: process.env[only] }
  t.after(() => {
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }
  })
  process.env[enabled] = 'true'
  process.env[only] = 'false'
  const source = {
    available: true,
    metadata: 'disabled',
    path: 'private-folder/Fixture.nes',
    revision: 'fixture-revision',
  } as const
  await library.insert(romTable).values([
    { fileId: 'mounted-file-id', fileName: 'Fixture.nes', id: 'mounted', mountedSource: source, platform: 'nes' },
    { fileId: 'uploaded-file-id', fileName: 'Fixture.chd', id: 'uploaded', platform: 'psx', userId: 'owner' },
    { fileId: 'stranger-file-id', fileName: 'Not shared.nes', id: 'secret', platform: 'nes', userId: 'stranger' },
  ])
  const before = await library.select().from(romTable)
  const owner = await create('owner', 'Owner list')
  const reader = await create('reader', 'Reader list')

  for (const [user, collection] of [
    ['owner', owner],
    ['reader', reader],
  ] as const) {
    const memberPath = `${endpoint}/${collection.id}/roms`
    await expectStatus(request(user, `${memberPath}/secret`, { method: 'PUT' }), 404)
    await expectStatus(request(user, `${memberPath}/missing`, { method: 'PUT' }), 404)
    for (const result of await Promise.all([
      request(user, `${memberPath}/mounted`, { method: 'PUT' }),
      request(user, `${memberPath}/mounted`, { method: 'PUT' }),
      request(user, `${memberPath}/uploaded`, { method: 'PUT' }),
    ])) {
      assert.equal(result.status, 200, await result.clone().text())
      assert.deepEqual(await result.json(), null)
    }
    const response = await read(user, `/lists/${collection.id}`)
    const detail = collectionDetail.parse(response)
    assert.equal(detail.pagination.total, 2)
    assert.deepEqual(
      detail.roms.map(({ id, platform }) => [id, platform]),
      [
        ['uploaded', 'psx'],
        ['mounted', 'nes'],
      ],
    )
    assert.doesNotMatch(JSON.stringify(response), /private-folder|mounted-file-id|Not shared/u)
    const selector = await expectStatus(request(user, `${endpoint}/for-rom/uploaded`), 200)
    assert.equal(selector.headers.get('Cache-Control'), 'private, no-store')
    assert.deepEqual(await selector.json(), [{ ...collection, includesGame: true }])
  }

  async function expectVisibleRomIds(ids: string[]) {
    for (const [user, collection] of [
      ['owner', owner],
      ['reader', reader],
    ] as const) {
      assert.deepEqual(await read(user), [{ ...collection, total: ids.length }])
      const detail = collectionDetail.parse(await read(user, `/lists/${collection.id}`))
      assert.equal(detail.pagination.total, ids.length)
      assert.deepEqual(
        detail.roms.map(({ id }) => id),
        ids,
      )
    }
  }

  process.env[only] = 'true'
  await expectVisibleRomIds(['mounted'])
  await expectStatus(request('reader', `${endpoint}/for-rom/uploaded`), 404)
  process.env[only] = 'false'
  process.env[enabled] = 'false'
  await expectVisibleRomIds(['uploaded'])
  process.env[enabled] = 'true'

  await library.update(romTable).set({ status: statusEnum.deleted }).where(eq(romTable.id, 'mounted'))
  await expectVisibleRomIds(['uploaded'])
  await library.update(romTable).set({ status: statusEnum.normal }).where(eq(romTable.id, 'mounted'))
  await expectVisibleRomIds(['uploaded', 'mounted'])
  await library
    .update(romTable)
    .set({ mountedSource: { ...source, available: false } })
    .where(eq(romTable.id, 'mounted'))
  await expectVisibleRomIds(['uploaded'])
  await expectStatus(request('owner', `${endpoint}/for-rom/mounted`), 404)

  for (const romId of ['mounted', 'mounted', 'secret']) {
    await expectStatus(request('reader', `${endpoint}/${reader.id}/roms/${romId}`, { method: 'DELETE' }), 200)
  }
  await library.update(romTable).set({ mountedSource: source }).where(eq(romTable.id, 'mounted'))
  assert.deepEqual(await read('reader'), [{ ...reader, total: 1 }])
  assert.deepEqual(await read('owner'), [{ ...owner, total: 2 }])
  await expectStatus(request('owner', `${endpoint}/${owner.id}`, { method: 'DELETE' }), 200)
  assert.deepEqual(await read('reader'), [{ ...reader, total: 1 }])
  const after = await library.select().from(romTable)
  assert.deepEqual(
    after.map(({ updatedAt: _, ...rom }) => rom),
    before.map(({ updatedAt: _, ...rom }) => rom),
  )
})

await it('rejects an add if the ROM is hidden or the collection is deleted just before the write', async (t) => {
  const { create, library, request, sqlite } = fixture(t)
  const { id: collectionId } = await create('owner', 'Weekend picks')
  const romId = 'fixture-rom'
  await library.insert(romTable).values({
    fileId: 'fixture-content',
    fileName: 'Fixture.nes',
    id: romId,
    platform: 'nes',
    userId: 'owner',
  })
  const prepare = sqlite.prepare.bind(sqlite)
  let invalidate: (() => void) | undefined
  t.mock.method(sqlite, 'prepare', (query: string) => {
    if (invalidate && query.startsWith('insert into "game_collection_roms"')) {
      invalidate()
      invalidate = undefined
    }
    return prepare(query)
  })
  const memberPath = `${endpoint}/${collectionId}/roms/${romId}`

  invalidate = () => {
    prepare('UPDATE roms SET status = ? WHERE id = ?').run(statusEnum.deleted, romId)
  }
  const hidden = await expectStatus(request('owner', memberPath, { method: 'PUT' }), 404)
  assert.deepEqual(await hidden.json(), { message: 'ROM not found' })

  prepare('UPDATE roms SET status = ? WHERE id = ?').run(statusEnum.normal, romId)
  invalidate = () => {
    prepare('UPDATE game_collections SET status = ? WHERE id = ?').run(statusEnum.deleted, collectionId)
  }
  const deleted = await expectStatus(request('owner', memberPath, { method: 'PUT' }), 404)
  assert.deepEqual(await deleted.json(), { message: 'Collection not found' })
  assert.deepEqual(await library.select().from(gameCollectionRomTable), [])
})
