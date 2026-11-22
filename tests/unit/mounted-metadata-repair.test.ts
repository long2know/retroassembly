import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { it, type TestContext } from 'node:test'
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { Hono } from 'hono'
import { contextStorage } from 'hono/context-storage'
import { z } from 'zod'
import { app as api } from '#@/api/app.ts'
import { romTable, sessionTable, statusEnum, userTable } from '#@/databases/schema.ts'
import { auth } from '#@/middlewares/auth.ts'
import { baseUrl } from '#@/middlewares/base-url.ts'
import { globals } from '#@/middlewares/globals.ts'
import { getLegacyMountedCoverFallbacks } from '#@/utils/client/mounted-cover.ts'
import { createDrizzle } from '#@/utils/server/drizzle.ts'
import { getMountedConfiguration } from '#@/utils/server/mounted-files.ts'
import { setMountedLibrary } from '#@/utils/server/mounted-library-runtime.ts'
import { createMountedLibrary } from '#@/utils/server/mounted-library.ts'
import { enrichMountedRom, getMountedCoverUrl } from '#@/utils/server/mounted-metadata.ts'
import { createStorage } from '#@/utils/server/storage.ts'
import { createSupabase } from '#@/utils/server/supabase.ts'
import { catalogTitles, syntheticCatalog, syntheticCover } from '../e2e/fixtures/synthetic-catalog.ts'

const matchesSchema = z.object({
  candidates: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      region: z.string().optional(),
      revision: z.string().optional(),
      shortName: z.string().optional(),
      year: z.number().optional(),
    }),
  ),
  snapshot: z.string(),
})

async function setup(t: TestContext, files: Record<string, string | Uint8Array>) {
  const root = path.resolve('tests/.mounted-library-fixtures', `repair-${randomUUID()}`)
  const data = path.join(root, 'data')
  const roms = path.join(root, 'roms')
  const storage = path.join(data, 'storage')
  await mkdir(storage, { recursive: true })
  for (const [relative, bytes] of Object.entries(files)) {
    const file = path.join(roms, relative)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, bytes)
  }
  t.mock.property(process, 'env', {
    ...process.env,
    BASE_URL: '',
    RETROASSEMBLY_RUN_TIME_DATA_DIRECTORY: data,
    RETROASSEMBLY_RUN_TIME_ENABLE_SHARED_ROM_LIBRARY: 'true',
    RETROASSEMBLY_RUN_TIME_MSLEUTH_FALLBACK_HOST: '',
    RETROASSEMBLY_RUN_TIME_MSLEUTH_HOST: 'https://metadata.fixture.invalid',
    RETROASSEMBLY_RUN_TIME_SHARED_LIBRARY_ONLY: 'false',
    RETROASSEMBLY_RUN_TIME_SHARED_ROM_DIRECTORY: roms,
    RETROASSEMBLY_RUN_TIME_SHARED_ROM_METADATA_ENABLED: 'true',
    RETROASSEMBLY_RUN_TIME_SHARED_ROM_SCAN_INTERVAL: '0',
    RETROASSEMBLY_RUN_TIME_STORAGE_DIRECTORY: storage,
  })
  const { library } = createDrizzle()
  t.after(async () => {
    setMountedLibrary(undefined)
    library.$client.close()
    await rm(root, { force: true, recursive: true })
  })
  migrate(library, { migrationsFolder: 'src/databases/migrations' })
  await library.insert(userTable).values([
    { createdAt: new Date(1), id: 'owner', username: 'Owner' },
    { createdAt: new Date(2), id: 'viewer', username: 'Viewer' },
  ])
  await library.insert(sessionTable).values({
    expiresAt: new Date(Date.now() + 3_600_000),
    token: 'synthetic-viewer',
    userId: 'viewer',
  })
  const configuration = await getMountedConfiguration()
  assert.ok(configuration)
  const mounted = createMountedLibrary(library, configuration)
  mounted.updateSettings({ automaticMetadata: false })
  setMountedLibrary(mounted)
  await mounted.scan()

  const app = new Hono()
    .use(contextStorage())
    .use(baseUrl())
    .use(async (c, next) => {
      c.set('db', { library })
      c.set('storage', createStorage())
      c.set('supabase', createSupabase())
      await next()
    })
    .use(globals(), auth())
    .route('', api)

  async function request(endpoint: string, init?: RequestInit, status = 200) {
    const headers = new Headers(init?.headers)
    headers.set('Authorization', 'Bearer synthetic-viewer')
    const response = await app.request(`/api/v1/roms/${endpoint}`, { ...init, headers })
    assert.equal(response.status, status, await response.clone().text())
    return response
  }
  function byId(id: string) {
    const result = library.select().from(romTable).where(eq(romTable.id, id)).get()
    assert.ok(result)
    return result
  }
  return { byId, configuration, data, library, request, roms, storage }
}

function post(json?: object): RequestInit {
  return { body: json && JSON.stringify(json), headers: { 'Content-Type': 'application/json' }, method: 'POST' }
}

function requestUrl(input: string | URL | Request) {
  return new URL(input instanceof Request ? input.url : input)
}

function mockProvider(t: TestContext, respond: (url: URL, init?: RequestInit) => Response) {
  t.mock.method(globalThis, 'fetch', (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    Promise.resolve(respond(requestUrl(input), init)),
  )
}

async function assertProblem(pending: Promise<Response>, code: string) {
  const response = await pending
  const problem = z.object({ code: z.string() }).parse(await response.json())
  assert.equal(problem.code, code)
}

async function assertArtwork(pending: Promise<Response>, artwork: string) {
  const response = await pending
  assert.deepEqual(await response.json(), { artwork })
}

function digest(data: Uint8Array) {
  return createHash('sha256').update(data).digest('hex')
}

await it('previews a scoped catalog without edits, confirms only the chosen title, and safely retries its artwork', async (t) => {
  const f = await setup(t, {
    'n64/Synthetic outside catalog.z64': 'n64 source',
    'nes/Untitled mounted game.nes': 'nes source',
  })
  const rows = f.library.select().from(romTable).all()
  const nes = rows.find(({ platform }) => platform === 'nes')
  const n64 = rows.find(({ platform }) => platform === 'n64')
  assert.ok(nes && n64 && nes.mountedSource)
  const sourceFile = path.join(f.roms, nes.mountedSource.path)
  const before = digest(await readFile(sourceFile))
  const requests: URL[] = []
  let cover: 'missing' | 'available' | 'unsafe' = 'missing'
  mockProvider(t, (url, init) => {
    requests.push(url)
    assert.equal(init?.redirect, 'error')
    if (url.origin === 'https://raw.githubusercontent.com') {
      assert.equal(url.search, '')
      assert.match(url.pathname, /^\/libretro\/libretro-database\/90601bff67dba7057381292f17e08ed2cecbd6dc\/rdb\//u)
      const system = decodeURIComponent(url.pathname.split('/').at(-1) || '')
      assert.ok(['Nintendo - Nintendo Entertainment System.rdb', 'Nintendo - Nintendo 64.rdb'].includes(system))
      return new Response(syntheticCatalog(system.includes('64') ? 'n64' : 'nes'), {
        headers: { 'Content-Type': 'application/octet-stream' },
      })
    }
    if (url.origin === 'https://thumbnails.libretro.com') {
      return cover === 'unsafe'
        ? new Response('<html>not an image</html>', { headers: { 'Content-Type': 'image/png' } })
        : new Response(null, { status: 404 })
    }
    assert.equal(url.origin, 'https://cdn.jsdelivr.net')
    assert.match(
      decodeURIComponent(url.pathname),
      /\/Nintendo_-_Nintendo_Entertainment_System@8cc31d11631684ea26e5e2c0d4d77d5f30651a1d\/Named_Boxarts\//u,
    )
    return cover === 'available'
      ? new Response(syntheticCover(), { headers: { 'Content-Type': 'image/png' } })
      : new Response(null, { status: 404 })
  })
  async function search(id: string, query = 'circuit lan') {
    const response = await f.request(`${id}/match?${new URLSearchParams({ query })}`)
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
    return matchesSchema.parse(await response.json())
  }

  const endpoint = `${nes.id}/match`
  const retry = `${nes.id}/retry-artwork`
  const [results, empty] = await Promise.all([search(nes.id), search(nes.id, 'no such title')])
  assert.deepEqual(empty.candidates, [])
  assert.deepEqual(f.byId(nes.id), nes)
  assert.equal(requests.length, 1, 'concurrent searches share one catalog load')
  assert.equal(results.candidates.length, 3)
  assert.deepEqual(results.candidates.find(({ name }) => name.endsWith('DX'))?.region, 'Japan')
  assert.deepEqual(results.candidates.find(({ name }) => name.endsWith('DX'))?.revision, 'Rev B')
  const sequel = results.candidates.find(({ name }) => name === catalogTitles.sequel)
  const original = results.candidates.find(({ name }) => name === catalogTitles.original)
  assert.ok(sequel && original)
  assert.equal(sequel.year, 1996)
  const dataFiles = await readdir(f.data)
  assert.ok(!dataFiles.some((filename) => filename.endsWith('.rdb')))

  const other = await search(n64.id)
  assert.deepEqual(
    other.candidates.map(({ name }) => name),
    [catalogTitles.n64],
  )
  const [n64Candidate] = other.candidates
  assert.ok(n64Candidate)
  for (const candidateId of [n64Candidate.id, '0'.repeat(64)]) {
    await assertProblem(
      f.request(endpoint, post({ candidateId, snapshot: results.snapshot }), 409),
      'invalid-candidate',
    )
  }
  await f.request(endpoint, post({ candidateId: sequel.id, gameName: 'forged', snapshot: results.snapshot }), 400)

  const notes = new FormData()
  notes.set('gameDescription', 'My own notes')
  notes.set('gamePlayers', '3')
  await f.request(nes.id, { body: notes, method: 'PATCH' })
  await assertProblem(
    f.request(endpoint, post({ candidateId: sequel.id, snapshot: results.snapshot }), 409),
    'metadata-stale',
  )
  assert.equal(f.byId(nes.id).gameName, null)
  const fresh = await search(nes.id)
  const applied = await f.request(endpoint, post({ candidateId: sequel.id, snapshot: fresh.snapshot }))
  assert.deepEqual(await applied.json(), { artwork: 'missing' })
  const matched = f.byId(nes.id)
  assert.equal(matched.gameName, catalogTitles.sequel)
  assert.equal(matched.gameReleaseYear, 1996)
  assert.equal(matched.gameDescription, 'My own notes')
  assert.equal(matched.gamePlayers, 3)
  assert.equal(matched.gameDeveloper, 'Synthetic Works')
  assert.equal(matched.gameBoxartFileIds, null)
  assert.equal(matched.libretroGameId, null, 'a local catalog key is not a provider ID')
  assert.equal(matched.mountedSource?.metadataOutcome, 'matched')
  assert.equal(matched.mountedSource?.artwork, 'missing')

  cover = 'available'
  await assertArtwork(f.request(retry, post()), 'ready')
  const ready = f.byId(nes.id)
  assert.ok(ready.gameBoxartFileIds)
  assert.ok(ready.gameBoxartFileIds.startsWith(`metadata/${nes.id}/`))
  assert.deepEqual(await readFile(path.join(f.storage, ready.gameBoxartFileIds)), syntheticCover())
  assert.equal(ready.gameName, matched.gameName)
  assert.equal(ready.mountedSource?.metadataAttemptedAt, matched.mountedSource?.metadataAttemptedAt)
  assert.deepEqual(
    requests.slice(-2).map((url) => url.origin),
    ['https://thumbnails.libretro.com', 'https://cdn.jsdelivr.net'],
  )

  cover = 'unsafe'
  const prior = requests.length
  await assertArtwork(f.request(retry, post()), 'error')
  assert.equal(requests.length, prior + 1, 'unsafe origin data does not fall back')
  const failure = f.byId(nes.id)
  assert.match(failure.mountedSource?.artworkError || '', /declared image type/u)
  assert.equal(failure.gameBoxartFileIds, ready.gameBoxartFileIds)
  assert.equal(failure.mountedSource?.metadataOutcome, 'matched')

  const changed = await search(nes.id)
  await assertArtwork(f.request(endpoint, post({ candidateId: original.id, snapshot: changed.snapshot })), 'error')
  const corrected = f.byId(nes.id)
  assert.equal(corrected.gameName, catalogTitles.original)
  assert.equal(corrected.gameBoxartFileIds, null, 'a cover for a different title is no longer shown')
  assert.equal(corrected.mountedSource?.metadataOutcome, 'matched')

  const upload = new FormData()
  upload.set('file', new File([syntheticCover(2)], 'custom.png', { type: 'image/png' }))
  const stored = await f.request(`${nes.id}/boxart`, { body: upload, method: 'POST' })
  const attachment = z.string().parse(await stored.json())
  const quiet = requests.length
  const manual = await search(nes.id)
  await assertArtwork(f.request(endpoint, post({ candidateId: sequel.id, snapshot: manual.snapshot })), 'manual')
  assert.equal(f.byId(nes.id).gameBoxartFileIds, attachment)
  await f.request(`${nes.id}/boxart`, { method: 'DELETE' })
  await assertArtwork(f.request(retry, post()), 'manual')
  assert.equal(f.byId(nes.id).gameBoxartFileIds, null)
  assert.equal(f.byId(nes.id).mountedSource?.artwork, 'manual')
  assert.equal(requests.length, quiet)
  assert.equal(digest(await readFile(sourceFile)), before)

  process.env.RETROASSEMBLY_RUN_TIME_SHARED_ROM_METADATA_ENABLED = 'false'
  for (const action of [
    f.request(`${endpoint}?query=lantern`, undefined, 403),
    f.request(endpoint, post({ candidateId: sequel.id, snapshot: manual.snapshot }), 403),
    f.request(retry, post(), 403),
  ]) {
    await assertProblem(action, 'metadata-policy')
  }
  process.env.RETROASSEMBLY_RUN_TIME_SHARED_ROM_METADATA_ENABLED = 'true'
  await f.library.update(romTable).set({ status: statusEnum.deleted }).where(eq(romTable.id, nes.id))
  await f.request(`${endpoint}?query=lantern`, undefined, 404)
  await f.request(endpoint, post({ candidateId: sequel.id, snapshot: manual.snapshot }), 404)
  await f.request(retry, post(), 404)
  await f.library.insert(romTable).values({
    fileId: 'roms/owner/private.nes',
    fileName: 'Private fixture.nes',
    id: 'private',
    platform: 'nes',
    userId: 'owner',
  })
  await f.request('private/match?query=lantern', undefined, 404)
  assert.equal(requests.length, quiet)
})

await it('distinguishes a catalog failure from no match and rejects a changed mounted revision', async (t) => {
  const arcadeFile = 'arcade/Unknown arcade.zip'
  const f = await setup(t, {
    [arcadeFile]: 'arcade fixture',
    'PCENGINECD/Synthetic disc.bin': 'disc fixture',
    'psx/Unused.chd': 'PS1 disc fixture',
    'supergrafx/Synthetic cart.pce': 'SuperGrafx fixture',
  })
  const rows = f.library.select().from(romTable).all()
  const arcade = rows.find(({ platform }) => platform === 'arcade')
  const psx = rows.find(({ platform }) => platform === 'psx')
  assert.ok(arcade && psx)
  let requests = 0
  mockProvider(t, (url, init) => {
    assert.equal(url.origin, 'https://raw.githubusercontent.com')
    assert.equal(init?.redirect, 'error')
    requests += 1
    if (url.pathname.endsWith('/MAME.rdb')) {
      return new Response(syntheticCatalog('arcade'), { headers: { 'Content-Type': 'application/octet-stream' } })
    }
    assert.ok(url.pathname.endsWith('/Sony%20-%20PlayStation.rdb'))
    return new Response('Oversized fixture', {
      headers: { 'Content-Length': `${11 * 1024 * 1024}`, 'Content-Type': 'application/octet-stream' },
    })
  })
  const wrongScopes = rows.filter(({ platform }) => platform === 'pcengine')
  assert.equal(wrongScopes.length, 2)
  for (const { id } of wrongScopes) {
    await assertProblem(f.request(`${id}/match?query=any`, undefined, 422), 'catalog-unsupported')
    const forged = { candidateId: '0'.repeat(64), snapshot: '0'.repeat(64) }
    await assertProblem(f.request(`${id}/match`, post(forged), 422), 'catalog-unsupported')
  }
  assert.equal(requests, 0, 'cartridge catalog must not be downloaded for PC Engine CD or SuperGrafx')
  await assertProblem(f.request(`${psx.id}/match?query=any`, undefined, 502), 'catalog-provider')
  assert.deepEqual(f.byId(psx.id), psx)
  const response = await f.request(`${arcade.id}/match?query=lntrn`)
  const { candidates, snapshot } = matchesSchema.parse(await response.json())
  assert.deepEqual(
    candidates.map(({ name, shortName }) => [name, shortName]),
    [['Lantern’s Circuit (World)', 'lntrn']],
  )
  await writeFile(path.join(f.roms, arcadeFile), 'Changed source replacement')
  await assertProblem(
    f.request(`${arcade.id}/match`, post({ candidateId: candidates[0].id, snapshot }), 409),
    'metadata-stale',
  )
  assert.deepEqual(f.byId(arcade.id), arcade)
  assert.equal(requests, 2)
})

await it('preserves only changed full-form fields on a later catalog selection', async (t) => {
  const f = await setup(t, { 'famicom/Existing identification.nes': 'synthetic Famicom fixture' })
  const [indexed] = f.library.select().from(romTable).all()
  assert.ok(indexed.mountedSource)
  assert.equal(indexed.platform, 'nes')
  const releaseDate = new Date('1991-08-04T12:37:00Z')
  await f.library
    .update(romTable)
    .set({
      gameDescription: 'Old provider description',
      gameDeveloper: 'Old provider developer',
      gameGenres: '',
      gameName: 'Existing identification',
      gameReleaseDate: releaseDate,
      mountedSource: { ...indexed.mountedSource, metadata: 'ready', metadataOutcome: 'matched' },
    })
    .where(eq(romTable.id, indexed.id))
  const before = f.byId(indexed.id)
  const form = new FormData()
  for (const [field, value] of Object.entries({
    gameDescription: 'Old provider description',
    gameDeveloper: 'Old provider developer',
    gameGenres: '',
    gameName: 'Existing identification',
    gamePlayers: 'unknown',
    gamePublisher: '',
    gameReleaseDate: '08/04/1991',
  })) {
    form.set(field, value)
  }
  const edit = { body: form, headers: { 'Accept-Language': 'en' }, method: 'PATCH' }
  await f.request(indexed.id, edit)
  assert.deepEqual(f.byId(indexed.id), before, 'a no-op does not write, round the date, or disable automatic updates')

  form.set('gameDescription', 'Only my description')
  await f.request(indexed.id, edit)
  const edited = f.byId(indexed.id)
  assert.deepEqual(edited.mountedSource?.manualMetadataFields, ['gameDescription'])
  assert.deepEqual(edited.gameReleaseDate, releaseDate)

  mockProvider(t, (url) => {
    if (url.origin === 'https://raw.githubusercontent.com') {
      assert.match(url.pathname, /\/Nintendo%20-%20Nintendo%20Entertainment%20System\.rdb$/u)
      return new Response(syntheticCatalog('nes'), { headers: { 'Content-Type': 'application/octet-stream' } })
    }
    return new Response(null, { status: 404 })
  })
  const results = await f.request(`${indexed.id}/match?query=circuit`)
  const { candidates, snapshot } = matchesSchema.parse(await results.json())
  const sequel = candidates.find(({ name }) => name === catalogTitles.sequel)
  assert.ok(sequel)
  await assertArtwork(f.request(`${indexed.id}/match`, post({ candidateId: sequel.id, snapshot })), 'missing')
  const matched = f.byId(indexed.id)
  assert.equal(matched.gameName, catalogTitles.sequel)
  assert.equal(matched.gameDescription, 'Only my description')
  assert.equal(matched.gameDeveloper, 'Synthetic Works')
  assert.equal(matched.gameReleaseDate, null)
  assert.equal(matched.gameReleaseYear, 1996)

  assert.ok(matched.mountedSource)
  await f.library
    .update(romTable)
    .set({
      gameDeveloper: 'Curated before field-level tracking',
      mountedSource: { ...matched.mountedSource, catalogMatch: undefined, manualMetadataFields: undefined },
    })
    .where(eq(romTable.id, indexed.id))
  const legacySearch = await f.request(`${indexed.id}/match?query=circuit`)
  const legacy = matchesSchema.parse(await legacySearch.json())
  const original = legacy.candidates.find(({ name }) => name === catalogTitles.original)
  assert.ok(original)
  await assertArtwork(
    f.request(`${indexed.id}/match`, post({ candidateId: original.id, snapshot: legacy.snapshot })),
    'missing',
  )
  assert.equal(f.byId(indexed.id).gameDeveloper, 'Curated before field-level tracking')
})

await it('uses only authorized legacy provider artwork, including title and gameplay screenshots', () => {
  const source = {
    artwork: 'missing',
    available: true,
    metadata: 'ready',
    path: 'nes/Game.nes',
    revision: 'fixture',
  } as const
  const legacy: Parameters<typeof getLegacyMountedCoverFallbacks>[0] = {
    fileName: 'Nested/Fixture cartridge.nes',
    gameBoxartFileIds: null,
    gameName: 'Legacy Lantern',
    mountedSource: source,
    platform: 'nes',
    rawGameMetadata: {
      launchbox: { name: 'Legacy Lantern' },
      libretro: { name: 'Legacy Lantern (World)', platform: 'Nintendo - Nintendo Entertainment System' },
    },
  }
  const enabled = getLegacyMountedCoverFallbacks(legacy, true).map((url) => new URL(url))
  assert.deepEqual(
    enabled.slice(0, 3).map((url) => decodeURIComponent(url.pathname)),
    ['Boxarts', 'Titles', 'Snaps'].map(
      (type) => `/Nintendo - Nintendo Entertainment System/Named_${type}/Legacy Lantern (World).png`,
    ),
  )
  assert.ok(enabled.some((url) => url.origin === 'https://cdn.jsdelivr.net' && url.pathname.includes('/Named_Titles/')))
  assert.ok(enabled.some((url) => decodeURIComponent(url.pathname).endsWith('/Fixture cartridge.png')))
  assert.deepEqual(getLegacyMountedCoverFallbacks(legacy, false), [])
  for (const rom of [
    { ...legacy, gameBoxartFileIds: 'attachments/fixture/manual.png' },
    { ...legacy, mountedSource: { ...source, artwork: 'manual' as const } },
    { ...legacy, mountedSource: { ...source, catalogMatch: { id: 'another', name: 'Chosen title' } } },
    { ...legacy, gameName: 'Replaced by a new title' },
    { ...legacy, rawGameMetadata: null },
    {
      ...legacy,
      rawGameMetadata: {
        libretro: { name: 'Legacy Lantern', platform: 'Nintendo - Nintendo 64' },
      },
    },
  ]) {
    assert.deepEqual(getLegacyMountedCoverFallbacks(rom, true), [])
  }
})

await it('keeps the digest authoritative, uses only the ZIP payload basename, and falls back to the outer basename', async (t) => {
  const payload = new Uint8Array([1, 2, 3])
  const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false })
  await zip.add('synthetic/Filename association.nes', new Uint8ArrayReader(payload))
  const archive = await zip.close()
  const zipPath = 'nes/other folder/Archive association.zip'
  const f = await setup(t, { [zipPath]: archive, 'n64/Cartridge.z64': 'N64 fixture' })
  const rows = f.library.select().from(romTable).all()
  const nes = rows.find(({ platform }) => platform === 'nes')
  const n64 = rows.find(({ platform }) => platform === 'n64')
  assert.ok(nes && n64)
  const md5 = createHash('md5').update(payload).digest('hex')
  let hashFound = true
  const names: string[] = []
  const coverRequests: string[] = []
  mockProvider(t, (url, init) => {
    if (url.origin === 'https://metadata.fixture.invalid') {
      assert.equal(url.pathname, '/api/v1/metadata/identify')
      const request = z
        .object({ files: z.array(z.object({ md5: z.string().optional(), name: z.string() })), platform: z.string() })
        .parse(JSON.parse(String(init?.body)))
      const [file] = request.files
      assert.ok(file)
      names.push(file.name)
      if (request.platform === 'n64') {
        return Response.json([{ libretro: { name: catalogTitles.n64 } }])
      }
      if (file.name === 'Filename association.nes') {
        assert.equal(file.md5, md5)
        return hashFound ? Response.json([{ libretro: { md5, name: 'Real hash match' } }]) : Response.json([{}])
      }
      assert.deepEqual(file, { name: 'Archive association.zip' })
      return Response.json([{ libretro: { name: 'Outer fallback match' } }])
    }
    assert.equal(init?.redirect, 'error')
    const file = decodeURIComponent(url.pathname)
    coverRequests.push(file)
    return url.origin === 'https://thumbnails.libretro.com'
      ? new Response(null, { status: 404 })
      : new Response(syntheticCover(), { headers: { 'Content-Type': 'image/png' } })
  })

  const exact = await enrichMountedRom(f.library, nes, { root: f.configuration.roms })
  assert.equal(exact.gameName, 'Real hash match')
  assert.equal(exact.mountedSource?.identification?.confidence, 'content')
  assert.deepEqual(names, ['Filename association.nes'])
  hashFound = false
  const fallback = await enrichMountedRom(f.library, exact, { root: f.configuration.roms })
  assert.equal(fallback.gameName, 'Outer fallback match')
  assert.equal(fallback.mountedSource?.identification?.confidence, 'filename')
  assert.deepEqual(names, ['Filename association.nes', 'Filename association.nes', 'Archive association.zip'])
  assert.equal(digest(await readFile(path.join(f.roms, zipPath))), digest(archive))

  const captured = await enrichMountedRom(f.library, n64, { root: f.configuration.roms })
  assert.equal(captured.mountedSource?.artwork, 'ready')
  assert.equal(getMountedCoverUrl('n64', catalogTitles.n64).origin, 'https://thumbnails.libretro.com')
  assert.deepEqual(coverRequests.slice(-2), [
    `/Nintendo - Nintendo 64/Named_Boxarts/${catalogTitles.n64}.png`,
    `/gh/libretro-thumbnails/Nintendo_-_Nintendo_64@ff0badea277f2d2d15e9008b04f1a0fd6abc40a3/Named_Boxarts/${catalogTitles.n64}.png`,
  ])
})
