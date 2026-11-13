import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { Hono } from 'hono'
import { contextStorage } from 'hono/context-storage'
import { matchRoutes } from 'react-router'
import { z } from 'zod'
import { app as api } from '#@/api/app.ts'
import { getMountedFormat, resolveMountedPlatform } from '#@/constants/mounted-library.ts'
import {
  favoriteTable,
  launchRecordTable,
  libraryModeEnum,
  romTable,
  sessionTable,
  stateTable,
  userTable,
} from '#@/databases/schema.ts'
import { auth } from '#@/middlewares/auth.ts'
import { globals } from '#@/middlewares/globals.ts'
import { getRomUrl } from '#@/pages/library/utils/rom.ts'
import { routes } from '#@/pages/routes.ts'
import { createDrizzle } from '#@/utils/server/drizzle.ts'
import {
  getMountedConfiguration,
  getMountedFileId,
  getMountedPath,
  validateMountedRelativePath,
  validateMountedRoot,
} from '#@/utils/server/mounted-files.ts'
import { getMountedIdentification } from '#@/utils/server/mounted-identification.ts'
import { setMountedLibrary } from '#@/utils/server/mounted-library-runtime.ts'
import { createMountedLibrary } from '#@/utils/server/mounted-library.ts'
import { cacheMountedCover, enrichMountedRom, getMountedCoverUrl } from '#@/utils/server/mounted-metadata.ts'
import { createFilesystemStorage, createStorage } from '#@/utils/server/storage.ts'
import { createSupabase } from '#@/utils/server/supabase.ts'

const romResponse = z.object({
  fileId: z.string(),
  fileName: z.string(),
  gameBoxartFileIds: z.string().nullable(),
  gameName: z.string().nullable(),
  id: z.string(),
  isFavorite: z.union([z.boolean(), z.number()]),
  mountedSource: z
    .object({
      available: z.boolean(),
      metadata: z.string(),
      metadataError: z.string().optional(),
      path: z.string(),
      revision: z.string(),
      unsupportedReason: z.string().optional(),
    })
    .nullable(),
  platform: z.string(),
  userId: z.string().nullable(),
})
const romListResponse = z.object({
  pagination: z.object({ total: z.number() }),
  roms: z.array(romResponse),
})

const defaultFiles = { 'roms/NES/Nested/雪 & Hero.NES': 'original ROM' }

function createFixtureApp(library: ReturnType<typeof createDrizzle>['library']) {
  const app = new Hono()
  app.use(contextStorage())
  app.use(async (c, next) => {
    c.set('db', { library })
    c.set('storage', createStorage())
    c.set('supabase', createSupabase())
    await next()
  })
  app.use(globals(), auth())
  app.route('', api)
  return app
}

async function expectStatus(pending: Promise<Response>, status: number) {
  const response = await pending
  assert.equal(response.status, status, await response.clone().text())
  return response
}

function compareInventory(first: string[], second: string[]) {
  return JSON.stringify(first).localeCompare(JSON.stringify(second), 'en')
}

function getFetchUrl(input: Parameters<typeof fetch>[0]) {
  return new URL(input instanceof Request ? input.url : String(input))
}

async function getIdentifyName(input: Parameters<typeof fetch>[0], init?: RequestInit) {
  let body: unknown
  if (input instanceof Request) {
    body = await input.clone().json()
  } else {
    if (typeof init?.body !== 'string') {
      throw new TypeError('Expected a JSON identification request')
    }
    body = JSON.parse(init.body)
  }
  const parsed = z.object({ files: z.array(z.object({ name: z.string() })) }).parse(body)
  const [file] = parsed.files
  assert.ok(file)
  return file.name
}

async function writeFixture(root: string, relative: string, bytes: string | Uint8Array) {
  const filename = path.join(root, relative)
  await mkdir(path.dirname(filename), { recursive: true })
  await writeFile(filename, bytes)
}

async function sourceSnapshot(root: string, relative = '') {
  const result: Record<string, { bytes: string; changed: number; modified: number }> = {}
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const filename = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      Object.assign(result, await sourceSnapshot(root, filename))
    } else if (entry.isFile()) {
      const info = await stat(path.join(root, filename))
      result[filename] = {
        bytes: createHash('sha256')
          .update(await readFile(path.join(root, filename)))
          .digest('hex'),
        changed: info.ctimeMs,
        modified: info.mtimeMs,
      }
    }
  }
  return result
}

async function fixture(t: TestContext, files: Record<string, string | Uint8Array> = defaultFiles) {
  const root = path.resolve('tests/.mounted-library-fixtures', randomUUID())
  const connections: ReturnType<typeof createDrizzle>['library'][] = []
  t.after(async () => {
    setMountedLibrary(undefined)
    for (const connection of connections) {
      connection.$client.close()
    }
    await rm(root, { force: true, recursive: true })
  })
  const data = path.join(root, 'data')
  const storage = path.join(data, 'storage')
  const roms = path.join(root, 'roms')
  const bios = path.join(root, 'bios')
  for (const directory of [storage, roms, bios]) {
    await mkdir(directory, { recursive: true })
  }
  for (const [filename, bytes] of Object.entries(files)) {
    await writeFixture(root, filename, bytes)
  }
  t.mock.property(process, 'env', {
    ...process.env,
    RETROASSEMBLY_RUN_TIME_DATA_DIRECTORY: data,
    RETROASSEMBLY_RUN_TIME_ENABLE_SHARED_ROM_LIBRARY: 'true',
    RETROASSEMBLY_RUN_TIME_MSLEUTH_FALLBACK_HOST: '',
    RETROASSEMBLY_RUN_TIME_MSLEUTH_HOST: 'https://metadata.fixture.invalid/',
    RETROASSEMBLY_RUN_TIME_OIDC_CLIENT_ID: '',
    RETROASSEMBLY_RUN_TIME_OIDC_CLIENT_SECRET: '',
    RETROASSEMBLY_RUN_TIME_OIDC_ISSUER: '',
    RETROASSEMBLY_RUN_TIME_SHARED_BIOS_DIRECTORY: bios,
    RETROASSEMBLY_RUN_TIME_SHARED_LIBRARY_ONLY: 'true',
    RETROASSEMBLY_RUN_TIME_SHARED_ROM_DIRECTORY: roms,
    RETROASSEMBLY_RUN_TIME_SHARED_ROM_METADATA_ENABLED: 'false',
    RETROASSEMBLY_RUN_TIME_SHARED_ROM_SCAN_INTERVAL: '0',
    RETROASSEMBLY_RUN_TIME_STORAGE_DIRECTORY: storage,
    RETROASSEMBLY_RUN_TIME_STORAGE_HOST: '',
    RETROASSEMBLY_RUN_TIME_SUPABASE_ANON_KEY: '',
    RETROASSEMBLY_RUN_TIME_SUPABASE_URL: '',
    RETROASSEMBLY_RUN_TIME_SUPERVISER_USER_IDS: '',
  })
  const { library } = createDrizzle()
  connections.push(library)
  migrate(library, { migrationsFolder: 'src/databases/migrations' })
  await library.insert(userTable).values([
    { id: 'alice', username: 'Alice' },
    { id: 'bob', libraryMode: libraryModeEnum.shared, username: 'Bob' },
  ])
  for (const user of ['alice', 'bob']) {
    await library.insert(sessionTable).values({
      expiresAt: new Date(Date.now() + 3_600_000),
      token: `fixture-${user}`,
      userId: user,
    })
  }
  const configuration = await getMountedConfiguration()
  assert.ok(configuration)
  const mounted = createMountedLibrary(library, configuration)
  setMountedLibrary(mounted)
  await mounted.scan()
  const app = createFixtureApp(library)

  async function request(url: string, init?: RequestInit, user = 'alice') {
    const headers = new Headers(init?.headers)
    if (user) {
      headers.set('Authorization', `Bearer fixture-${user}`)
    }
    return await app.request(`/api/v1${url}`, { ...init, headers })
  }

  async function list(user = 'alice') {
    const response = await request('/roms', undefined, user)
    assert.equal(response.status, 200)
    return romListResponse.parse(await response.json())
  }

  return { bios, configuration, data, library, list, mounted, request, roms, root, storage }
}

const mountedStatusResponse = z.object({
  automaticMetadataEnabled: z.boolean(),
  indexed: z.number(),
  metadata: z.object({
    errors: z.number(),
    operation: z.enum(['metadata', 'artwork']).optional(),
    processed: z.number(),
    running: z.boolean(),
    total: z.number(),
  }),
  networkAllowed: z.boolean(),
  platforms: z.array(z.object({ indexed: z.number(), platform: z.string(), unsupported: z.number() })),
  settings: z.object({ automaticMetadata: z.boolean(), scanIntervalSeconds: z.number() }),
  unsupported: z.number(),
})

async function createSyntheticZip(files: Record<string, string | Uint8Array>) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false })
  for (const [filename, value] of Object.entries(files)) {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
    await writer.add(filename, new Uint8ArrayReader(bytes), { directory: filename.endsWith('/'), level: 0 })
  }
  return await writer.close()
}

async function getIdentifyInput(input: Parameters<typeof fetch>[0], init?: RequestInit) {
  const request = input instanceof Request ? input.clone() : new Request(input, init)
  return z
    .object({ files: z.array(z.object({ md5: z.string().optional(), name: z.string() })), platform: z.string() })
    .parse(await request.json())
}

function enableFixtureMetadata(f: Awaited<ReturnType<typeof fixture>>) {
  process.env.RETROASSEMBLY_RUN_TIME_SHARED_ROM_METADATA_ENABLED = 'true'
  f.mounted.stop()
  const mounted = createMountedLibrary(f.library, { ...f.configuration, metadataEnabled: true })
  setMountedLibrary(mounted)
  return mounted
}

async function finishMetadataJob(mounted: ReturnType<typeof createMountedLibrary>) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const status = mounted.getStatus()
    if (!status.metadata.running) {
      return status
    }
    await delay(10)
  }
  assert.fail('Mounted metadata job did not finish')
}

await describe('mounted shared library', async () => {
  await it('round-trips nested card URLs through the actual router without double encoding', () => {
    for (const fileName of ['Homebrew/Immutable Pulse.nes', 'Favorites/雪 & 100% #1?.NES']) {
      for (const isDemo of [false, true]) {
        const rom = { fileName, id: 'mounted-game', platform: 'nes' }
        const url = getRomUrl(rom, isDemo)
        const pattern = isDemo ? routes.demoPlatformRom : routes.libraryPlatformRom
        const [matched] = matchRoutes([{ path: pattern }], url) || []
        assert.ok(matched)
        assert.equal(matched.params.fileName, fileName)
        assert.equal(matched.params.platform, 'nes')
        const parsed = new URL(url, 'http://fixture.local')
        assert.equal(parsed.searchParams.get('rom_id'), isDemo ? null : rom.id)
        assert.equal(parsed.pathname.includes('%252F'), false)
      }
    }
  })

  await it('indexes nested ES-DE aliases without changing names, source bytes, or per-user ownership', async (t) => {
    const f = await fixture(t, {
      'roms/constructor/ignored.nes': 'not a platform alias',
      'roms/FAMICOM/Family/Hero.NES': 'nes bytes',
      'roms/fbneo/game.zip': 'synthetic archive; not a compatible ROM set claim',
      'roms/genesis/Europe/Same.gen': 'third game at an identical aliased path',
      'roms/MASTERSYSTEM/Collections/日本語 & 100%.SMS': 'sms bytes',
      'roms/md/USA/Same.GEN': 'second game',
      'roms/MEGADRIVE/Europe/Same.gen': 'first game',
      'roms/NES/gamelist.xml': '<gameList/>',
      'roms/ps3/not-a-supported-browser-game.iso': 'ignored system',
      'roms/SFC/お気に入り/Hero.sfc': 'snes bytes',
    })
    const before = await sourceSnapshot(f.roms)
    const alice = await f.list()
    const bob = await f.list('bob')
    assert.deepEqual(
      bob.roms.map((rom) => rom.id),
      alice.roms.map((rom) => rom.id),
    )
    assert.equal(alice.pagination.total, 7)
    assert.deepEqual(
      alice.roms.map((rom) => [rom.platform, rom.fileName]).toSorted(compareInventory),
      [
        ['sms', 'Collections/日本語 & 100%.SMS'],
        ['genesis', 'Europe/Same.gen'],
        ['genesis', 'USA/Same.GEN'],
        ['genesis', 'Europe/Same.gen'],
        ['nes', 'Family/Hero.NES'],
        ['snes', 'お気に入り/Hero.sfc'],
        ['arcade', 'game.zip'],
      ].toSorted(compareInventory),
    )
    const sameNames = alice.roms.filter((rom) => rom.platform === 'genesis' && rom.fileName === 'Europe/Same.gen')
    assert.equal(sameNames.length, 2)
    assert.notEqual(getRomUrl(sameNames[0]), getRomUrl(sameNames[1]))
    for (const sameName of sameNames) {
      assert.equal(new URL(getRomUrl(sameName), 'http://fixture.local').searchParams.get('rom_id'), sameName.id)
    }
    for (const rom of alice.roms) {
      assert.equal(rom.userId, null)
      assert.match(rom.fileId, /^mounted\/roms\/[a-f0-9]{64}$/u)
      assert.equal(rom.mountedSource?.metadata, 'disabled')
    }
    const sms = alice.roms.find((rom) => rom.platform === 'sms')
    assert.ok(sms)
    const searched = await f.request('/roms/search?query=%E6%97%A5%E6%9C%AC%E8%AA%9E', {}, 'bob')
    assert.equal(searched.status, 200)
    assert.ok(romListResponse.parse(await searched.json()).roms.some((rom) => rom.id === sms.id))
    const response = await f.request(`/files/${encodeURIComponent(sms.fileId)}`, {}, 'bob')
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Content-Type'), 'application/octet-stream')
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
    assert.equal(await response.text(), 'sms bytes')
    const head = await f.request(`/files/${encodeURIComponent(sms.fileId)}`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('Content-Length'), '9')
    assert.equal(await head.text(), '')
    const content = await f.request(`/roms/${sms.id}/content`)
    assert.equal(content.status, 200)
    assert.equal(await content.text(), 'sms bytes')
    assert.deepEqual(await sourceSnapshot(f.roms), before)
    assert.deepEqual(await readdir(f.storage), [])
    const users = await f.library.select().from(userTable)
    assert.equal(users.length, 2)
    const anonymous = await f.request(`/roms/${sms.id}`, {}, '')
    assert.notEqual(anonymous.status, 200)
  })

  await it('reconciles idempotently, invalidates same-path replacements, and preserves rows after incomplete scans', async (t) => {
    const f = await fixture(t)
    const [original] = await f.library.select().from(romTable)
    assert.ok(original.mountedSource)
    await Promise.all([f.mounted.scan(), f.mounted.scan()])
    const [unchanged] = await f.library.select().from(romTable)
    assert.equal(unchanged.id, original.id)
    assert.equal(unchanged.updatedAt.getTime(), original.updatedAt.getTime())
    await f.library
      .update(romTable)
      .set({ gameName: 'Old automatic match', mountedSource: { ...original.mountedSource, metadata: 'ready' } })
      .where(eq(romTable.id, original.id))
    await writeFixture(f.roms, original.mountedSource.path, 'replacement bytes with a different size')
    await expectStatus(f.request(`/files/${encodeURIComponent(original.fileId)}`), 409)
    await f.mounted.scan()
    const [replaced] = await f.library.select().from(romTable)
    assert.equal(replaced.id, original.id)
    assert.equal(replaced.fileId, original.fileId)
    assert.notEqual(replaced.mountedSource?.revision, original.mountedSource.revision)
    assert.equal(replaced.gameName, null)
    const unavailableRoot = path.join(f.root, 'temporarily-unmounted-roms')
    await rename(f.roms, unavailableRoot)
    await mkdir(f.roms)
    await assert.rejects(f.mounted.scan(), /unavailable or changed/u)
    const preserved = await f.list()
    assert.equal(preserved.pagination.total, 1)
    assert.match(f.mounted.getStatus().error || '', /unavailable or changed/u)
    await rm(f.roms, { recursive: true })
    await rename(unavailableRoot, f.roms)
    await rm(path.join(f.roms, original.mountedSource.path))
    await f.mounted.scan()
    const removed = await f.list()
    assert.equal(removed.pagination.total, 0)
    const [missing] = await f.library.select().from(romTable)
    assert.equal(missing.id, original.id)
    assert.equal(missing.status, 1)
    assert.equal(missing.mountedSource?.available, false)
  })

  await it('keeps favorites, launch history, state content, and deletion private for shared games', async (t) => {
    const f = await fixture(t)
    const {
      roms: [rom],
    } = await f.list()
    const favorite = await f.request('/favorites', {
      body: JSON.stringify({ romId: rom.id }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    })
    assert.equal(favorite.status, 200)
    const aliceFavorites = await f.list()
    const bobFavorites = await f.list('bob')
    assert.equal(Boolean(aliceFavorites.roms[0].isFavorite), true)
    assert.equal(Boolean(bobFavorites.roms[0].isFavorite), false)
    const launchForm = new FormData()
    launchForm.set('rom', rom.id)
    launchForm.set('core', 'fceumm')
    await expectStatus(f.request('/launch_records', { body: launchForm, method: 'POST' }), 200)
    const aliceHistory = await f.request('/launch_records')
    const bobHistory = await f.request('/launch_records', {}, 'bob')
    assert.equal(z.object({ roms: z.array(z.unknown()) }).parse(await aliceHistory.json()).roms.length, 1)
    assert.equal(z.object({ roms: z.array(z.unknown()) }).parse(await bobHistory.json()).roms.length, 0)
    const form = new FormData()
    form.set('core', 'fceumm')
    form.set('rom', rom.id)
    form.set('state', new Blob(['private state']))
    form.set('thumbnail', new Blob(['private thumbnail']))
    form.set('type', 'manual')
    const stateResponse = await f.request('/states', { body: form, method: 'POST' })
    assert.equal(stateResponse.status, 200, await stateResponse.clone().text())
    const state = z
      .object({ fileId: z.string(), id: z.string(), thumbnailFileId: z.string() })
      .parse(await stateResponse.json())
    process.env.RETROASSEMBLY_RUN_TIME_STORAGE_HOST = 'https://storage.fixture.invalid/'
    for (const id of [state.fileId, state.thumbnailFileId]) {
      const owner = await f.request(`/files/${encodeURIComponent(id)}`)
      assert.equal(owner.status, 200)
      await owner.body?.cancel()
      await expectStatus(f.request(`/files/${encodeURIComponent(id)}`, {}, 'bob'), 404)
    }
    const otherStates = await f.request(`/roms/${rom.id}/states`, {}, 'bob')
    assert.deepEqual(await otherStates.json(), [])
    await expectStatus(f.request(`/states/${state.id}`, { method: 'DELETE' }, 'bob'), 200)
    const [persisted] = await f.library.select().from(stateTable)
    assert.equal(persisted.status, 1)
    assert.equal(await readFile(path.join(f.storage, state.fileId), 'utf8'), 'private state')
    const [favoriteRecord] = await f.library.select().from(favoriteTable)
    const [launchRecord] = await f.library.select().from(launchRecordTable)
    assert.equal(favoriteRecord.userId, 'alice')
    assert.equal(launchRecord.userId, 'alice')
  })

  await it('edits metadata/art and hides shared games without deleting or reimporting source files', async (t) => {
    const f = await fixture(t)
    const {
      roms: [rom],
    } = await f.list()
    const before = await sourceSnapshot(f.roms)
    const patch = new FormData()
    patch.set('gameName', 'My corrected title')
    patch.set('gameDescription', 'App-owned correction')
    const edited = await f.request(`/roms/${rom.id}`, { body: patch, method: 'PATCH' }, 'bob')
    assert.equal(edited.status, 200)
    const editedList = await f.list()
    assert.equal(editedList.roms[0].gameName, 'My corrected title')
    const art = new FormData()
    art.set('file', new File(['app-owned artwork'], 'cover.png', { type: 'image/png' }))
    const artResponse = await f.request(`/roms/${rom.id}/boxart`, { body: art, method: 'POST' }, 'bob')
    assert.equal(artResponse.status, 200)
    const artId = z.string().parse(await artResponse.json())
    assert.match(artId, /^attachments\/bob\//u)
    assert.equal(await readFile(path.join(f.storage, artId), 'utf8'), 'app-owned artwork')
    const sharedArt = await f.request(`/files/${encodeURIComponent(artId)}`)
    assert.equal(sharedArt.status, 200)
    assert.equal(await sharedArt.text(), 'app-owned artwork')
    const [customArt] = await f.library.select().from(romTable).where(eq(romTable.id, rom.id))
    assert.equal(customArt.mountedSource?.artwork, 'manual')
    assert.equal(customArt.mountedSource?.artworkError, undefined)
    await expectStatus(f.request(`/roms/${rom.id}/boxart`, { method: 'DELETE' }, 'bob'), 200)
    const [removedArt] = await f.library.select().from(romTable).where(eq(romTable.id, rom.id))
    assert.equal(removedArt.gameBoxartFileIds, null)
    assert.equal(removedArt.mountedSource?.artwork, 'manual')
    const privateFileId = 'roms/nes/private-upload.nes'
    await writeFixture(f.storage, privateFileId, 'private uploaded ROM')
    await f.library.insert(romTable).values({
      fileId: privateFileId,
      fileName: 'Private upload.nes',
      platform: 'nes',
      userId: 'alice',
    })
    const attemptedReference = new FormData()
    attemptedReference.set('gameBoxartFileIds', privateFileId)
    await expectStatus(f.request(`/roms/${rom.id}`, { body: attemptedReference, method: 'PATCH' }, 'bob'), 200)
    await expectStatus(f.request(`/files/${encodeURIComponent(privateFileId)}`, {}, 'bob'), 404)
    await f.mounted.scan()
    const rescanned = await f.list()
    assert.equal(rescanned.roms[0].gameName, 'My corrected title')
    await expectStatus(f.request(`/roms/${rom.id}`, { method: 'DELETE' }, 'bob'), 200)
    await f.mounted.scan()
    const hiddenList = await f.list()
    assert.equal(hiddenList.pagination.total, 0)
    assert.deepEqual(await sourceSnapshot(f.roms), before)
    const [hidden] = await f.library.select().from(romTable).where(eq(romTable.id, rom.id))
    assert.equal(hidden.status, 0)
  })

  await it('discovers only expected BIOS names recursively, validates checksums, and supplies core virtual names', async (t) => {
    const f = await fixture(t, {
      'bios/fds/DISKSYS.ROM': 'invalid synthetic checksum',
      'bios/Odyssey2/nested/O2ROM.BIN': 'synthetic bytes, not valid firmware',
      'bios/private.txt': 'must not be exposed',
      'roms/odyssey2/Example.bin': 'synthetic game',
    })
    const before = await sourceSnapshot(f.bios)
    const preference = await f.request('/preference', {}, 'bob')
    const parsed = z
      .object({
        emulator: z.object({
          platform: z.object({
            fds: z.object({ bioses: z.array(z.unknown()) }),
            odyssey2: z.object({ bioses: z.array(z.object({ fileId: z.string(), fileName: z.string() })) }),
          }),
        }),
      })
      .parse(await preference.json())
    const [bios] = parsed.emulator.platform.odyssey2.bioses
    assert.ok(bios)
    assert.equal(bios.fileName, 'o2rom.bin')
    assert.match(bios.fileId, /^mounted\/bios\/[a-f0-9]{64}$/u)
    assert.deepEqual(parsed.emulator.platform.fds.bioses, [])
    assert.ok(f.mounted.getStatus().warnings.some((warning) => warning.includes('checksum')))
    const content = await f.request(`/files/${encodeURIComponent(bios.fileId)}`, {}, 'bob')
    assert.equal(content.status, 200)
    assert.equal(await content.text(), 'synthetic bytes, not valid firmware')
    await expectStatus(f.request('/preference/bioses?platform=odyssey2&file_name=o2rom.bin', { method: 'DELETE' }), 403)
    const arbitraryId = getMountedFileId('bios', 'private.txt')
    await expectStatus(f.request(`/files/${encodeURIComponent(arbitraryId)}`), 404)
    assert.deepEqual(await sourceSnapshot(f.bios), before)
  })

  await it('rejects source traversal, symlinks, overlapping writable roots, and mounted writes/deletes', async (t) => {
    const f = await fixture(t)
    for (const relative of [
      '../outside',
      '/etc/passwd',
      'NES/../../outside',
      String.raw`NES\outside`,
      '%2e%2e/outside',
      'NES/%252e%252e/outside',
      'NES/%2foutside',
    ]) {
      assert.throws(() => validateMountedRelativePath(relative), /Invalid/u)
    }
    await assert.rejects(validateMountedRoot(f.roms, [f.root]), /overlaps/u)
    await assert.rejects(validateMountedRoot(f.roms, [path.join(f.roms, 'metadata')]), /overlaps/u)
    await assert.rejects(validateMountedRoot(path.join(f.root, 'missing'), [f.data]), /ENOENT/u)
    const {
      roms: [rom],
    } = await f.list()
    const before = await sourceSnapshot(f.roms)
    const storage = createFilesystemStorage(f.storage)
    await assert.rejects(storage.put(rom.fileId, new Blob(['must not overwrite'])), /read-only/u)
    await assert.rejects(storage.delete(rom.fileId), /read-only/u)
    await assert.rejects(storage.put('../roms/escape.nes', new Blob(['escape'])), /Invalid/u)
    await assert.rejects(storage.get('%2e%2e/roms/escape.nes'), /Invalid/u)
    await writeFixture(f.root, 'outside.nes', 'outside fixture bytes')
    await symlink(path.join(f.root, 'outside.nes'), path.join(f.roms, 'NES', 'link.nes'))
    await symlink(path.join(f.root), path.join(f.roms, 'NES', 'linked-directory'))
    await f.mounted.scan()
    const rescanned = await f.list()
    assert.equal(rescanned.pagination.total, 1)
    await assert.rejects(getMountedPath(f.configuration.roms, 'NES/link.nes'), /Symbolic links/u)
    await assert.rejects(getMountedPath(f.configuration.roms, 'NES/linked-directory/outside.nes'), /Symbolic links/u)
    await symlink(f.roms, path.join(f.storage, 'escape'))
    await assert.rejects(storage.put('escape/new.nes', new Blob(['escape'])), /symlinks/u)
    await assert.rejects(storage.delete('escape/NES'), /symlinks/u)
    assert.deepEqual(await sourceSnapshot(f.roms), before)
    assert.ok(rom.mountedSource)
    await link(path.join(f.roms, rom.mountedSource.path), path.join(f.storage, 'hardlink.nes'))
    const linkedBefore = await sourceSnapshot(f.roms)
    await assert.rejects(storage.put('hardlink.nes', new Blob(['must not overwrite via hardlink'])), /Hard-linked/u)
    await assert.rejects(storage.delete('hardlink.nes'), /Hard-linked/u)
    assert.deepEqual(await sourceSnapshot(f.roms), linkedBefore)
  })

  await it('caches provider metadata/art only in app storage and preserves manual corrections during enrichment', async (t) => {
    const f = await fixture(t)
    process.env.RETROASSEMBLY_RUN_TIME_SHARED_ROM_METADATA_ENABLED = 'true'
    const [rom] = await f.library.select().from(romTable)
    const before = await sourceSnapshot(f.roms)
    const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const requests: URL[] = []
    t.mock.method(globalThis, 'fetch', (input) => {
      const url = getFetchUrl(input)
      requests.push(url)
      if (url.origin === 'https://metadata.fixture.invalid') {
        return Promise.resolve(
          Response.json([
            {
              launchbox: {
                databaseId: 42,
                developer: 'Fixture studio',
                name: 'Identified title',
                overview: 'Provider metadata',
              },
              libretro: { id: 'fixture-game', name: 'Identified title (World)' },
            },
          ]),
        )
      }
      assert.equal(url.origin, 'https://thumbnails.libretro.com')
      return Promise.resolve(new Response(imageBytes, { headers: { 'Content-Type': 'image/png' } }))
    })
    const enriched = await enrichMountedRom(f.library, rom)
    assert.equal(enriched.gameName, 'Identified title')
    assert.equal(enriched.rawGameMetadata?.launchbox?.databaseId, 42)
    assert.match(enriched.gameBoxartFileIds || '', /^metadata\//u)
    assert.ok(enriched.gameBoxartFileIds)
    assert.deepEqual(await readFile(path.join(f.storage, enriched.gameBoxartFileIds)), Buffer.from(imageBytes))
    assert.equal(requests.filter((url) => url.origin === 'https://metadata.fixture.invalid').length, 1)
    assert.equal(requests.filter((url) => url.origin === 'https://thumbnails.libretro.com').length, 1)
    const correction = new FormData()
    correction.set('gameName', 'My manual correction')
    await expectStatus(f.request(`/roms/${rom.id}`, { body: correction, method: 'PATCH' }), 200)
    await assert.rejects(enrichMountedRom(f.library, enriched), /newer edit was preserved/u)
    await f.mounted.scan()
    const correctedList = await f.list()
    assert.equal(correctedList.roms[0].gameName, 'My manual correction')
    assert.equal(correctedList.roms[0].mountedSource?.metadata, 'manual')
    assert.deepEqual(await sourceSnapshot(f.roms), before)
    assert.equal(getMountedCoverUrl('nes', 'http://127.0.0.1/../../secrets').origin, 'https://thumbnails.libretro.com')
  })

  await it('persists enrichment failures, permits explicit retries/manual matches, and refuses unsafe art responses', async (t) => {
    const f = await fixture(t)
    enableFixtureMetadata(f)
    const [rom] = await f.library.select().from(romTable)
    let matches: unknown[] = []
    let imageType = 'text/html'
    let imageLength: string | undefined
    const requestedNames: string[] = []
    t.mock.method(globalThis, 'fetch', async (input, init) => {
      const url = getFetchUrl(input)
      if (url.origin === 'https://metadata.fixture.invalid') {
        requestedNames.push(await getIdentifyName(input, init))
        return Response.json(matches)
      }
      assert.equal(url.origin, 'https://thumbnails.libretro.com')
      const headers = new Headers({ 'Content-Type': imageType })
      if (imageLength) {
        headers.set('Content-Length', imageLength)
      }
      return new Response(new Uint8Array([1, 2, 3]), { headers })
    })
    await assert.rejects(enrichMountedRom(f.library, rom))
    const [failed] = await f.library.select().from(romTable)
    assert.equal(failed.mountedSource?.metadata, 'error')
    assert.equal(failed.mountedSource?.metadataOutcome, 'no-match')
    assert.ok(failed.mountedSource?.identification?.md5)
    assert.ok(failed.mountedSource?.metadataError)
    await f.library.update(romTable).set({ gameDeveloper: 'Stale provider developer' }).where(eq(romTable.id, rom.id))
    matches = [{ launchbox: { databaseId: 7, name: 'Manually matched game' } }]
    await assert.rejects(cacheMountedCover(failed, 'Matched game'), /unsupported image type/u)
    imageType = 'image/png'
    imageLength = `${11 * 1024 * 1024}`
    await assert.rejects(cacheMountedCover(failed, 'Matched game'), /larger than 10 MiB/u)
    imageLength = undefined
    const matched = await f.request(
      `/roms/${rom.id}/identify`,
      {
        body: JSON.stringify({ name: 'A corrected matching name' }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
      'bob',
    )
    assert.equal(matched.status, 200, await matched.clone().text())
    const updated = z
      .object({
        gameDeveloper: z.null(),
        gameName: z.string(),
        mountedSource: z.object({ metadata: z.string() }),
      })
      .parse(await matched.json())
    assert.equal(updated.gameName, 'Manually matched game')
    assert.equal(updated.mountedSource.metadata, 'manual')
    assert.equal(requestedNames.at(-1), 'A corrected matching name')
  })

  await it('retains ordinary uploaded ROM/BIOS behavior when disabled and rejects access to another library', async (t) => {
    const f = await fixture(t)
    process.env.RETROASSEMBLY_RUN_TIME_ENABLE_SHARED_ROM_LIBRARY = 'false'
    await f.library.update(userTable).set({ libraryMode: libraryModeEnum.isolated }).where(eq(userTable.id, 'bob'))
    t.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json([])))
    const empty = await f.list()
    assert.equal(empty.pagination.total, 0)
    const form = new FormData()
    form.set('file', new File(['owned upload bytes'], 'Owned game.nes'))
    form.set('platform', 'nes')
    const uploaded = await f.request('/roms', { body: form, method: 'POST' })
    assert.equal(uploaded.status, 200, await uploaded.clone().text())
    const ownRom = z.object({ fileId: z.string(), id: z.string(), userId: z.string() }).parse(await uploaded.json())
    assert.equal(ownRom.userId, 'alice')
    await expectStatus(f.request(`/roms/${ownRom.id}`, {}, 'bob'), 404)
    await expectStatus(f.request(`/roms/${ownRom.id}/content`, {}, 'bob'), 404)
    await expectStatus(f.request(`/files/${encodeURIComponent(ownRom.fileId)}`, {}, 'bob'), 404)
    await expectStatus(f.request(`/roms/${ownRom.id}`, { method: 'DELETE' }, 'bob'), 404)
    const favorite = await f.request(
      '/favorites',
      {
        body: JSON.stringify({ romId: ownRom.id }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
      'bob',
    )
    assert.equal(favorite.status, 404)
    const biosForm = new FormData()
    biosForm.set('file', new File(['uploaded palette'], 'nes.pal'))
    biosForm.set('platform', 'famicom')
    await expectStatus(f.request('/preference/bioses', { body: biosForm, method: 'POST' }), 200)
    const managedBiosFiles = await readdir(path.join(f.storage, 'bioses/famicom'))
    assert.equal(managedBiosFiles.length, 1)
    assert.equal(await readFile(path.join(f.storage, ownRom.fileId), 'utf8'), 'owned upload bytes')
  })

  await it('surfaces disc/playlist limits instead of launching incomplete dependencies', async (t) => {
    const f = await fixture(t, {
      'roms/PSX/Disc One/game.cue': 'FILE "track.bin" BINARY',
      'roms/PSX/game.chd': 'synthetic CHD',
    })
    const list = await f.list()
    const cue = list.roms.find((rom) => rom.fileName.endsWith('.cue'))
    const chd = list.roms.find((rom) => rom.fileName.endsWith('.chd'))
    assert.ok(cue?.mountedSource?.unsupportedReason?.includes('CUE/M3U'))
    assert.equal(chd?.mountedSource?.unsupportedReason, undefined)
    const form = new FormData()
    form.set('core', 'pcsx_rearmed')
    assert.ok(cue)
    form.set('rom', cue.id)
    const launch = await f.request('/launch_records', { body: form, method: 'POST' })
    assert.equal(launch.status, 422)
    assert.match(await launch.text(), /CUE\/M3U/u)
    assert.equal(getMountedFormat('psx', '.iso')?.supported, false)
    assert.equal(getMountedFormat('psx', '.bin')?.supported, false)
    assert.equal(resolveMountedPlatform('shadps4'), undefined)
  })

  await it('hashes the original ZIP cartridge payload, uses canonical art names, and reuses persisted negative-art and digest caches without source access', async (t) => {
    const payload = new Uint8Array([0x4e, 0x45, 0x53, 0x1a, 0x01, 0x00, 0x31, 0x72, 0x19, 0xa5])
    const zip = await createSyntheticZip({
      '__MACOSX/._Pulse.nes': 'Ignored resource fork',
      'cartridge/Inner Lantern.nes': payload,
      'docs/': '',
      'docs/readme.txt': 'Original synthetic identification fixture',
    })
    const f = await fixture(t, { 'roms/NES/Circuit Lantern (Demo) [p1][!].zip': zip })
    process.env.RETROASSEMBLY_RUN_TIME_SHARED_ROM_METADATA_ENABLED = 'true'
    const md5 = createHash('md5').update(payload).digest('hex')
    assert.notEqual(md5, createHash('md5').update(zip).digest('hex'))
    const before = await sourceSnapshot(f.roms)
    const [rom] = await f.library.select().from(romTable)
    const inputs: Awaited<ReturnType<typeof getIdentifyInput>>[] = []
    const covers: URL[] = []
    t.mock.method(globalThis, 'fetch', async (input, init) => {
      const url = getFetchUrl(input)
      if (url.origin === 'https://metadata.fixture.invalid') {
        const body = await getIdentifyInput(input, init)
        inputs.push(body)
        assert.equal(body.platform, 'nes')
        assert.deepEqual(body.files, [{ md5, name: 'Circuit Lantern (Demo) [p1][!].zip' }])
        return Response.json([
          {
            launchbox: { name: 'Circuit Lantern' },
            libretro: { id: 'synthetic-lantern', md5, name: 'Circuit Lantern (World)' },
          },
        ])
      }
      assert.equal(url.origin, 'https://thumbnails.libretro.com')
      covers.push(url)
      return new Response('No artwork for this canonical name', { status: 404 })
    })
    const identified = await enrichMountedRom(f.library, rom)
    assert.equal(identified.gameName, 'Circuit Lantern')
    assert.equal(identified.mountedSource?.metadata, 'ready')
    assert.equal(identified.mountedSource?.metadataOutcome, 'matched')
    assert.equal(identified.mountedSource?.metadataError, undefined)
    assert.equal(identified.mountedSource?.artwork, 'missing')
    assert.equal(identified.mountedSource?.artworkError, undefined)
    assert.equal(identified.gameBoxartFileIds, null)
    assert.equal(identified.mountedSource?.identification?.mode, 'zip-entry')
    assert.equal(identified.mountedSource?.identification?.payloadName, 'cartridge/Inner Lantern.nes')
    assert.equal(identified.mountedSource?.identification?.md5, md5)
    assert.equal(identified.mountedSource?.identification?.bytes, payload.byteLength)
    assert.equal(identified.mountedSource?.identification?.confidence, 'content')
    assert.ok(identified.mountedSource?.identification?.hashedAt)
    assert.deepEqual(
      covers.map((url) => decodeURIComponent(url.pathname).split('/').at(-1)),
      ['Circuit Lantern (World).png', 'Circuit Lantern.png'],
    )
    assert.deepEqual(await sourceSnapshot(f.roms), before)
    const detached = path.join(f.root, 'offline-source')
    await rename(f.roms, detached)
    try {
      const repeated = await enrichMountedRom(f.library, identified)
      assert.deepEqual(repeated.mountedSource?.identification, identified.mountedSource?.identification)
      assert.equal(repeated.mountedSource?.artworkAttemptedAt, identified.mountedSource?.artworkAttemptedAt)
      assert.equal(inputs.length, 2)
      assert.equal(covers.length, 2)
      const response = await expectStatus(f.request('/mounted-library'), 200)
      assert.equal(mountedStatusResponse.parse(await response.json()).indexed, 1)
    } finally {
      await rename(detached, f.roms)
    }
    assert.deepEqual(await sourceSnapshot(f.roms), before)
  })

  await it('selects system-eligible ZIP content, rejects ambiguous, unsafe, oversized and excessive-entry archives, and preserves arcade sets', async (t) => {
    const cartridge = new Uint8Array([0x91, 0x08, 0x23, 0x55])
    const single = await createSyntheticZip({
      '__MACOSX/._chip.bin': 'Junk',
      'payload/chip.bin': cartridge,
      'readme.txt': 'Not a ROM',
    })
    const multiple = await createSyntheticZip({ 'one.nes': cartridge, 'two.nes': new Uint8Array([1, 2, 3]) })
    const arcade = await createSyntheticZip({ 'cpu-one.bin': cartridge, 'cpu-two.bin': new Uint8Array([4, 5, 6]) })
    const unsafe = Buffer.from(await createSyntheticZip({ 'safe.nes': cartridge }))
    const safeName = Buffer.from('safe.nes')
    for (
      let offset = unsafe.indexOf(safeName);
      offset >= 0;
      offset = unsafe.indexOf(safeName, offset + safeName.length)
    ) {
      unsafe.set(Buffer.from('../x.nes'), offset)
    }
    const excessiveFiles: Record<string, string | Uint8Array> = { 'payload.nes': cartridge }
    for (let index = 0; index < 256; index += 1) {
      excessiveFiles[`notes/${index}.txt`] = 'x'
    }
    const oversized = Buffer.from(await createSyntheticZip({ 'large.nes': cartridge }))
    const central = oversized.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    assert.ok(central !== -1)
    oversized.writeUInt32LE(101 * 1024 * 1024, central + 24)
    const f = await fixture(t, {
      'roms/arcade/Set.zip': arcade,
      'roms/atari2600/Tagged.zip': single,
      'roms/NES/Multiple.zip': multiple,
      'roms/NES/Oversized.zip': oversized,
      'roms/NES/TooMany.zip': await createSyntheticZip(excessiveFiles),
      'roms/NES/Unsafe.zip': unsafe,
    })
    const rows = await f.library.select().from(romTable)
    const identified = new Map<string, Awaited<ReturnType<typeof getMountedIdentification>>>()
    for (const rom of rows) {
      identified.set(rom.fileName, await getMountedIdentification(rom, f.configuration.roms))
    }
    assert.equal(identified.get('Tagged.zip')?.mode, 'zip-entry')
    assert.equal(identified.get('Tagged.zip')?.md5, createHash('md5').update(cartridge).digest('hex'))
    assert.equal(identified.get('Tagged.zip')?.payloadName, 'payload/chip.bin')
    assert.match(identified.get('Multiple.zip')?.error || '', /multiple eligible ROM payloads/u)
    assert.match(identified.get('Unsafe.zip')?.error || '', /(?:Invalid mounted source path|Unsafe filename)/u)
    assert.match(identified.get('TooMany.zip')?.error || '', /more than 256 entries/u)
    assert.match(identified.get('Oversized.zip')?.error || '', /expanded size/u)
    for (const filename of ['Multiple.zip', 'Unsafe.zip', 'TooMany.zip', 'Oversized.zip']) {
      assert.equal(identified.get(filename)?.mode, 'ambiguous')
      assert.equal(identified.get(filename)?.md5, undefined)
    }
    assert.equal(identified.get('Set.zip')?.mode, 'arcade-set')
    assert.equal(identified.get('Set.zip')?.payloadName, undefined)
    assert.equal(identified.get('Set.zip')?.md5, createHash('md5').update(arcade).digest('hex'))
    process.env.RETROASSEMBLY_RUN_TIME_SHARED_ROM_METADATA_ENABLED = 'true'
    t.mock.method(globalThis, 'fetch', () => {
      throw new Error('Ambiguous archives must not issue automatic provider requests')
    })
    const ambiguous = rows.find((rom) => rom.fileName === 'Multiple.zip')
    assert.ok(ambiguous)
    await assert.rejects(enrichMountedRom(f.library, ambiguous), /multiple eligible ROM payloads/u)
    const [persisted] = await f.library.select().from(romTable).where(eq(romTable.id, ambiguous.id))
    assert.equal(persisted.mountedSource?.identification?.mode, 'ambiguous')
    assert.equal(persisted.mountedSource?.metadataOutcome, 'error')
  })

  await it('persists app-wide controls and reports all available platform counts independently of enabled choices without walking sources', async (t) => {
    const f = await fixture(t, {
      'roms/NES/Primary.nes': 'Original NES fixture',
      'roms/ps1/Unsupported.cue': 'Original unsupported disc descriptor',
      'roms/SFC/Secondary.sfc': 'Original SNES fixture',
    })
    await expectStatus(
      f.request('/preference', {
        body: JSON.stringify({ ui: { platforms: ['nes'] } }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }),
      200,
    )
    const updated = await expectStatus(
      f.request('/mounted-library', {
        body: JSON.stringify({ automaticMetadata: false, scanIntervalSeconds: 17 }),
        headers: { 'Content-Type': 'application/json' },
        method: 'PATCH',
      }),
      200,
    )
    const status = mountedStatusResponse.parse(await updated.json())
    assert.deepEqual(status.settings, { automaticMetadata: false, scanIntervalSeconds: 17 })
    assert.deepEqual(status.platforms, [
      { indexed: 1, platform: 'nes', unsupported: 0 },
      { indexed: 1, platform: 'psx', unsupported: 1 },
      { indexed: 1, platform: 'snes', unsupported: 0 },
    ])
    assert.equal(status.indexed, 3)
    assert.equal(status.unsupported, 1)
    const detached = path.join(f.root, 'offline-for-counts')
    await rename(f.roms, detached)
    try {
      const counts = await expectStatus(f.request('/mounted-library'), 200)
      assert.deepEqual(mountedStatusResponse.parse(await counts.json()).platforms, status.platforms)
      f.mounted.stop()
      const restarted = createMountedLibrary(f.library, f.configuration)
      setMountedLibrary(restarted)
      assert.deepEqual(restarted.getStatus().settings, status.settings)
      assert.deepEqual(restarted.getStatus().platforms, status.platforms)
    } finally {
      await rename(detached, f.roms)
    }
    await expectStatus(
      f.request('/mounted-library', {
        body: JSON.stringify({ scanIntervalSeconds: -1 }),
        headers: { 'Content-Type': 'application/json' },
        method: 'PATCH',
      }),
      400,
    )
    const [hidden] = await f.library.select().from(romTable).where(eq(romTable.platform, 'snes'))
    await f.library.update(romTable).set({ status: 0 }).where(eq(romTable.id, hidden.id))
    const response = await expectStatus(f.request('/mounted-library'), 200)
    assert.equal(
      mountedStatusResponse.parse(await response.json()).platforms.some((platform) => platform.platform === 'snes'),
      false,
    )
    const [unhashed] = await f.library.select().from(romTable).where(eq(romTable.platform, 'nes'))
    assert.equal(unhashed.mountedSource?.identification, undefined)
  })

  await it('allows explicit coalesced metadata and artwork jobs with automatic lookup off while preserving manual edits, associations and unchanged hashes', async (t) => {
    const f = await fixture(t, {
      'roms/NES/Automatic.nes': 'Original automatic fixture',
      'roms/NES/Manual.nes': 'Original manual fixture',
    })
    const mounted = enableFixtureMetadata(f)
    const rows = await f.library.select().from(romTable)
    const manual = rows.find((rom) => rom.fileName === 'Manual.nes')
    const automatic = rows.find((rom) => rom.fileName === 'Automatic.nes')
    assert.ok(manual?.mountedSource)
    assert.ok(automatic)
    await f.library
      .update(romTable)
      .set({
        gameBoxartFileIds: 'attachments/alice/custom.png',
        gameName: 'Manually corrected title',
        mountedSource: { ...manual.mountedSource, metadata: 'manual' },
      })
      .where(eq(romTable.id, manual.id))
    await f.library.insert(favoriteTable).values({ romId: manual.id, userId: 'alice' })
    await f.library
      .insert(launchRecordTable)
      .values({ core: 'fceumm', platform: 'nes', romId: manual.id, userId: 'alice' })
    await f.library.insert(stateTable).values({
      core: 'fceumm',
      fileId: 'states/alice/synthetic',
      platform: 'nes',
      romId: manual.id,
      thumbnailFileId: 'states/alice/synthetic.png',
      type: 'manual',
      userId: 'alice',
    })
    let providers = 0
    let covers = 0
    let artworkAvailable = false
    t.mock.method(globalThis, 'fetch', async (input, init) => {
      const url = getFetchUrl(input)
      if (url.origin === 'https://metadata.fixture.invalid') {
        providers += 1
        const body = await getIdentifyInput(input, init)
        assert.equal(body.files[0]?.name, 'Automatic.nes')
        assert.equal(body.files[0]?.md5, createHash('md5').update('Original automatic fixture').digest('hex'))
        await delay(20)
        return Response.json([
          { libretro: { id: 'automatic-fixture', md5: body.files[0]?.md5, name: 'Automatic canonical (World)' } },
        ])
      }
      assert.equal(url.origin, 'https://thumbnails.libretro.com')
      covers += 1
      return artworkAvailable
        ? new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { 'Content-Type': 'image/png' } })
        : new Response('Missing art', { status: 404 })
    })
    const settings = await expectStatus(
      f.request('/mounted-library', {
        body: JSON.stringify({ automaticMetadata: false, scanIntervalSeconds: 0 }),
        headers: { 'Content-Type': 'application/json' },
        method: 'PATCH',
      }),
      200,
    )
    const initial = mountedStatusResponse.parse(await settings.json())
    assert.equal(initial.networkAllowed, true)
    assert.equal(initial.automaticMetadataEnabled, false)
    const action = { body: JSON.stringify({}), headers: { 'Content-Type': 'application/json' }, method: 'POST' }
    const concurrent = await Promise.all([
      f.request('/mounted-library/metadata', action),
      f.request('/mounted-library/metadata', action),
    ])
    for (const response of concurrent) {
      assert.equal(response.status, 200)
      const job = mountedStatusResponse.parse(await response.json())
      assert.equal(job.metadata.operation, 'metadata')
      assert.equal(job.metadata.total, 1)
    }
    const finished = await finishMetadataJob(mounted)
    assert.equal(finished.metadata.errors, 0)
    assert.equal(finished.metadata.processed, 1)
    assert.equal(providers, 1)
    assert.equal(covers, 1)
    const [identified] = await f.library.select().from(romTable).where(eq(romTable.id, automatic.id))
    assert.equal(identified.mountedSource?.artwork, 'missing')
    const cached = identified.mountedSource?.identification
    assert.ok(cached?.hashedAt)
    artworkAvailable = true
    await expectStatus(f.request('/mounted-library/artwork', action), 200)
    await finishMetadataJob(mounted)
    assert.equal(providers, 1)
    assert.equal(covers, 2)
    const [withArt] = await f.library.select().from(romTable).where(eq(romTable.id, automatic.id))
    assert.equal(withArt.mountedSource?.artwork, 'ready')
    assert.match(withArt.gameBoxartFileIds || '', /^metadata\//u)
    assert.deepEqual(withArt.mountedSource?.identification, cached)
    await expectStatus(
      f.request('/mounted-library/metadata', { ...action, body: JSON.stringify({ platform: 'nes' }) }),
      200,
    )
    await finishMetadataJob(mounted)
    assert.equal(providers, 2)
    assert.equal(covers, 2)
    await expectStatus(f.request('/mounted-library', { method: 'POST' }), 200)
    await delay(10)
    const [unchanged] = await f.library.select().from(romTable).where(eq(romTable.id, automatic.id))
    assert.deepEqual(unchanged.mountedSource?.identification, cached)
    assert.equal(providers, 2)
    const [preserved] = await f.library.select().from(romTable).where(eq(romTable.id, manual.id))
    assert.equal(preserved.id, manual.id)
    assert.equal(preserved.gameName, 'Manually corrected title')
    assert.equal(preserved.gameBoxartFileIds, 'attachments/alice/custom.png')
    assert.equal(preserved.mountedSource?.metadata, 'manual')
    assert.equal(preserved.mountedSource?.identification, undefined)
    const [persistedFavorite] = await f.library.select().from(favoriteTable)
    const [persistedLaunch] = await f.library.select().from(launchRecordTable)
    const [persistedState] = await f.library.select().from(stateTable)
    assert.equal(persistedFavorite.romId, manual.id)
    assert.equal(persistedLaunch.romId, manual.id)
    assert.equal(persistedState.romId, manual.id)
    const restarted = createMountedLibrary(f.library, { ...f.configuration, metadataEnabled: true })
    setMountedLibrary(restarted)
    restarted.start()
    await delay(10)
    assert.equal(restarted.getStatus().settings.automaticMetadata, false)
    assert.equal(restarted.getStatus().metadata.running, false)
    assert.equal(providers, 2)
  })

  await it('keeps server network disable as a hard ceiling for every explicit action and preserves settings against unauthenticated writes', async (t) => {
    const f = await fixture(t)
    let requests = 0
    t.mock.method(globalThis, 'fetch', () => {
      requests += 1
      throw new Error('Server policy must prohibit provider requests')
    })
    const patch = {
      body: JSON.stringify({ automaticMetadata: true }),
      headers: { 'Content-Type': 'application/json' },
      method: 'PATCH',
    }
    const setting = await expectStatus(f.request('/mounted-library', patch), 200)
    const status = mountedStatusResponse.parse(await setting.json())
    assert.equal(status.settings.automaticMetadata, true)
    assert.equal(status.networkAllowed, false)
    assert.equal(status.automaticMetadataEnabled, false)
    const [rom] = await f.library.select().from(romTable)
    const action = { body: JSON.stringify({}), headers: { 'Content-Type': 'application/json' }, method: 'POST' }
    for (const endpoint of ['/mounted-library/metadata', '/mounted-library/artwork', `/roms/${rom.id}/identify`]) {
      await expectStatus(f.request(endpoint, action), 403)
    }
    const anonymous = await f.request(
      '/mounted-library',
      { ...patch, body: JSON.stringify({ automaticMetadata: false }) },
      '',
    )
    assert.notEqual(anonymous.status, 200)
    assert.equal(f.mounted.getStatus().settings.automaticMetadata, true)
    assert.equal(requests, 0)
    const [unmodified] = await f.library.select().from(romTable)
    assert.equal(unmodified.mountedSource?.identification, undefined)
  })

  await it('preserves unexpected artwork HTTP failures separately from valid identification instead of misclassifying them as missing art', async (t) => {
    const f = await fixture(t)
    process.env.RETROASSEMBLY_RUN_TIME_SHARED_ROM_METADATA_ENABLED = 'true'
    t.mock.method(globalThis, 'fetch', (input) => {
      const url = getFetchUrl(input)
      if (url.origin === 'https://metadata.fixture.invalid') {
        return Promise.resolve(Response.json([{ libretro: { id: 'synthetic-art-error', name: 'Art error fixture' } }]))
      }
      return Promise.resolve(new Response('Provider unavailable', { status: 503 }))
    })
    const [rom] = await f.library.select().from(romTable)
    const identified = await enrichMountedRom(f.library, rom)
    assert.equal(identified.mountedSource?.metadata, 'ready')
    assert.equal(identified.mountedSource?.metadataError, undefined)
    assert.equal(identified.mountedSource?.artwork, 'error')
    assert.match(identified.mountedSource?.artworkError || '', /HTTP 503/u)
  })
})
