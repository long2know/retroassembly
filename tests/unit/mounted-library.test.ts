import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs, {
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
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
import { inGameSaveAccountHeader, inGameSaveSize } from '#@/constants/in-game-save.ts'
import { getMountedFormat, mountedPlaylistMaxBytes, resolveMountedPlatform } from '#@/constants/mounted-library.ts'
import { getRomPlayback } from '#@/controllers/preference/rom-core-preference.ts'
import {
  favoriteTable,
  inGameSaveTable,
  launchRecordTable,
  libraryModeEnum,
  romCorePreferenceTable,
  romTable,
  sessionTable,
  stateTable,
  statusEnum,
  userTable,
} from '#@/databases/schema.ts'
import { auth } from '#@/middlewares/auth.ts'
import { baseUrl } from '#@/middlewares/base-url.ts'
import { globals } from '#@/middlewares/globals.ts'
import { createMountedPbpPreparation, fetchMountedPbp } from '#@/pages/library/utils/mounted-pbp.ts'
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
import { requireRom } from '#@/utils/server/rom-access.ts'
import { createFilesystemStorage, createStorage } from '#@/utils/server/storage.ts'
import { createSupabase } from '#@/utils/server/supabase.ts'
import { createSyntheticBatteryNesRom, createSyntheticNesRom } from '../e2e/fixtures/synthetic-nes.ts'
import { createSyntheticPsxPbp } from '../e2e/fixtures/synthetic-psx.ts'

const playlistBinding = z.object({ disc: z.number(), revision: z.string() })
const playlistResponse = z.object({
  discs: z.array(z.object({ path: z.string(), revision: z.string() })),
  revision: z.string(),
})

const romResponse = z.object({
  fileId: z.string(),
  fileName: z.string(),
  gameBoxartFileIds: z.string().nullable(),
  gameName: z.string().nullable(),
  id: z.string(),
  isFavorite: z.union([z.boolean(), z.number()]),
  mountedSource: z
    .object({
      artwork: z.string().optional(),
      available: z.boolean(),
      metadata: z.string(),
      metadataError: z.string().optional(),
      path: z.string(),
      pbpEndPatch: z.object({ end: z.number(), offset: z.number() }).optional(),
      playlist: playlistResponse.optional(),
      playlistIssue: z.object({ code: z.string(), line: z.number().optional() }).optional(),
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
  app.use(baseUrl())
  app.use(async (c, next) => {
    c.set('db', { library })
    c.set('storage', createStorage())
    c.set('supabase', createSupabase())
    await next()
  })
  app.use(globals(), auth())
  app.get('/api/v1/fixture/playback/:id', async (c) =>
    c.json(await getRomPlayback(await requireRom(c.req.param('id')))),
  )
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

async function seedLegacyHiddenRom(library: ReturnType<typeof createDrizzle>['library'], id: string) {
  await library.update(romTable).set({ status: statusEnum.deleted }).where(eq(romTable.id, id))
}

function playlistSaveForm(romId: string, type: 'auto' | 'manual', binding?: { disc: string; revision: string }) {
  const body = new FormData()
  body.set('core', 'pcsx_rearmed')
  body.set('rom', romId)
  body.set('state', new File(['state'], 'fixture.state'))
  body.set('thumbnail', new File(['thumbnail'], 'fixture.png'))
  body.set('type', type)
  if (binding) {
    body.set('disc', binding.disc)
    body.set('playlistRevision', binding.revision)
  }
  return { body, method: 'POST' }
}

function trackFileHandles(
  t: TestContext,
  configure?: (handle: FileHandle, filename: Parameters<typeof fs.open>[0]) => void,
) {
  const opened: { closeCalls: number; handle: FileHandle }[] = []
  const nativeOpen = fs.open
  async function trackOpen(...args: Parameters<typeof fs.open>) {
    const handle = await nativeOpen(...args)
    const record = { closeCalls: 0, handle }
    const { close } = handle
    async function trackClose() {
      record.closeCalls += 1
      await close()
    }
    t.mock.method(handle, 'close', trackClose)
    opened.push(record)
    configure?.(handle, args[0])
    return handle
  }
  t.mock.method(fs, 'open', trackOpen)
  syncBuiltinESMExports()
  t.after(function restoreFileHandleMocks() {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  return opened
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
    { createdAt: new Date(2), id: 'bob', libraryMode: libraryModeEnum.shared, username: 'Bob' },
    { createdAt: new Date(1), id: 'alice', username: 'Alice' },
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
      if (url.includes('/in-game-save?') && !headers.has(inGameSaveAccountHeader)) {
        headers.set(inGameSaveAccountHeader, user)
      }
    }
    return await app.request(`/api/v1${url}`, { ...init, headers })
  }

  async function list(user = 'alice') {
    const response = await request('/roms', undefined, user)
    assert.equal(response.status, 200)
    return romListResponse.parse(await response.json())
  }

  async function setCore(romId: string, core: string | null, user = 'alice') {
    return await request(
      `/preference/roms/${romId}/core`,
      { body: JSON.stringify({ core }), headers: { 'Content-Type': 'application/json' }, method: 'PUT' },
      user,
    )
  }

  async function playback(romId: string, user = 'alice') {
    const response = await expectStatus(request(`/fixture/playback/${romId}`, undefined, user), 200)
    return z
      .object({
        core: z.string(),
        gameCorePreference: z.object({ override: z.string().nullable(), platformCore: z.string() }).nullable(),
        state: z.object({ core: z.string(), id: z.string(), playlist: playlistBinding.nullable() }).optional(),
      })
      .parse(await response.json())
  }

  return { bios, configuration, data, library, list, mounted, playback, request, roms, root, setCore, storage }
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

function inGameSaveUrl(
  rom: { id: string; mountedSource?: { revision: string } | null },
  bytes: Uint8Array,
  core = 'fceumm',
) {
  const digest = createHash('sha256').update(bytes).digest('hex')
  const query = new URLSearchParams({ core, romDigest: digest })
  if (rom.mountedSource) {
    query.set('revision', rom.mountedSource.revision)
  }
  return `/roms/${rom.id}/in-game-save?${query}`
}

function putSave(data: string, version: string | null): RequestInit {
  return { body: JSON.stringify({ data, version }), headers: { 'Content-Type': 'application/json' }, method: 'PUT' }
}

async function savedJson(pending: Promise<Response>): Promise<unknown> {
  const response = await expectStatus(pending, 200)
  return await response.json()
}

const syncedVersion = z.object({ version: z.uuidv4() })

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
  await it('stores cartridge RAM privately with atomic creation and update preconditions', async (t) => {
    const filename = 'Battery.nes'
    const bytes = createSyntheticBatteryNesRom()
    const f = await fixture(t, { [`roms/nes/${filename}`]: bytes })
    const {
      roms: [rom],
    } = await f.list()
    assert.equal(rom.fileName, filename)
    const url = inGameSaveUrl(rom, bytes)
    const blank = await expectStatus(f.request(url), 200)
    assert.equal(blank.headers.get('Cache-Control'), 'private, no-store')
    assert.deepEqual(await blank.json(), { data: null, version: null })
    const payloads = [0x12, 0x34, 0x56, 0x78].map((byte) => Buffer.alloc(inGameSaveSize, byte).toString('base64'))

    async function race(first: string, second: string, version: string | null) {
      const contenders = [first, second]
      const responses = await Promise.all(contenders.map((data) => f.request(url, putSave(data, version))))
      assert.deepEqual(
        responses.map((response) => response.status).toSorted((a, b) => a - b),
        [200, 409],
      )
      assert.ok(responses.every((response) => response.headers.get('Cache-Control') === 'private, no-store'))
      const winner = responses.findIndex((response) => response.ok)
      const accepted = syncedVersion.parse(await responses[winner].json())
      assert.notEqual(accepted.version, version)
      assert.deepEqual(await savedJson(f.request(url)), {
        data: contenders[winner],
        version: accepted.version,
      })
      return { data: contenders[winner], version: accepted.version }
    }

    const first = await race(payloads[0], payloads[1], null)
    const second = await race(payloads[2], payloads[3], first.version)
    await expectStatus(f.request(url, putSave(first.data, first.version)), 409)
    const changedAccount = putSave(first.data, null)
    const headers = new Headers(changedAccount.headers)
    headers.set(inGameSaveAccountHeader, 'alice')
    await expectStatus(f.request(url, { headers }, 'bob'), 409)
    await expectStatus(f.request(url, { ...changedAccount, headers }, 'bob'), 409)
    assert.deepEqual(await savedJson(f.request(url, undefined, 'bob')), {
      data: null,
      version: null,
    })
    await expectStatus(f.request(url, putSave(first.data, second.version), 'bob'), 409)
    await expectStatus(f.request(url, putSave(first.data, null), 'bob'), 200)
    assert.deepEqual(await savedJson(f.request(url)), second)
    assert.deepEqual(await savedJson(f.request(`/roms/${rom.id}/states`)), [])
    const unauthorized = await expectStatus(f.request(url, undefined, ''), 400)
    assert.equal(unauthorized.headers.get('Cache-Control'), 'private, no-store')
  })

  await it('rejects invalid payloads, hidden or revised mounts, and mismatched core selections', async (t) => {
    const relative = 'roms/nes/Battery.nes'
    const bytes = createSyntheticBatteryNesRom()
    const plain = createSyntheticNesRom()
    const f = await fixture(t, { [relative]: bytes, 'roms/nes/Plain.nes': plain })
    const { roms } = await f.list()
    const rom = roms.find(({ fileName }) => fileName === 'Battery.nes')
    const noBattery = roms.find(({ fileName }) => fileName === 'Plain.nes')
    assert.ok(rom && noBattery)
    const url = inGameSaveUrl(rom, bytes)
    const data = Buffer.alloc(inGameSaveSize, 0xa5).toString('base64')
    await expectStatus(f.request(inGameSaveUrl(noBattery, plain), putSave(data, null)), 422)
    await expectStatus(f.request(inGameSaveUrl(rom, bytes, 'nestopia')), 400)
    await expectStatus(f.request(inGameSaveUrl({ id: rom.id }, bytes)), 409)
    await expectStatus(f.request(`${url}&userId=bob`), 400)
    await expectStatus(f.request(url.replace(/romDigest=.*/u, 'romDigest=invalid')), 400)
    await expectStatus(f.request(url, putSave('abcd', null)), 400)
    await expectStatus(f.request(url, putSave(data, 'not-a-version')), 400)
    await expectStatus(
      f.request(url, { ...putSave(data, null), body: JSON.stringify({ data, userId: 'bob', version: null }) }),
      400,
    )
    for (const length of [undefined, '1']) {
      const headers = new Headers({ 'Content-Type': 'application/json' })
      if (length) {
        headers.set('Content-Length', length)
      }
      await expectStatus(f.request(url, { ...putSave('A'.repeat(12_000), null), headers }), 413)
    }
    assert.deepEqual(await f.library.select().from(inGameSaveTable), [])
    const { version } = syncedVersion.parse(await savedJson(f.request(url, putSave(data, null))))
    await expectStatus(f.setCore(rom.id, 'nestopia'), 200)
    await expectStatus(f.request(url), 409)
    await expectStatus(f.request(url, putSave(data, version)), 409)
    await expectStatus(f.setCore(rom.id, null), 200)
    assert.deepEqual(await savedJson(f.request(url)), { data, version })

    const changed = Buffer.from(bytes)
    changed[1000] = 0x11
    await writeFixture(f.root, relative, changed)
    await expectStatus(f.request(url), 409)
    await expectStatus(f.request(url, putSave(data, version)), 409)
    await f.mounted.scan()
    const updated = await f.list()
    const updatedRom = updated.roms.find(({ id }) => id === rom.id)
    assert.ok(updatedRom?.mountedSource && rom.mountedSource)
    assert.notEqual(updatedRom.mountedSource.revision, rom.mountedSource.revision)
    const newUrl = inGameSaveUrl(updatedRom, changed)
    assert.deepEqual(await savedJson(f.request(newUrl)), { data: null, version: null })
    await expectStatus(f.request(url), 409)
    await expectStatus(f.request(inGameSaveUrl(rom, changed), putSave(data, null)), 409)
    await expectStatus(f.request(newUrl, putSave(data, version)), 409)
    await expectStatus(f.request(newUrl, putSave(data, null)), 200)
    await seedLegacyHiddenRom(f.library, rom.id)
    await expectStatus(f.request(newUrl), 404)
    await expectStatus(f.request(newUrl, putSave(data, null)), 404)
  })

  await it('uses uploaded file contents even when the ROM ID and storage ID do not change', async (t) => {
    const bytes = createSyntheticBatteryNesRom()
    const fileId = 'roms/famicom/private.nes'
    const f = await fixture(t, { [`data/storage/${fileId}`]: bytes })
    process.env.RETROASSEMBLY_RUN_TIME_SHARED_LIBRARY_ONLY = 'false'
    process.env.RETROASSEMBLY_RUN_TIME_MSLEUTH_HOST = ''
    const romId = 'private-upload'
    await f.library.insert(romTable).values({
      fileId,
      fileName: 'Private.nes',
      id: romId,
      platform: 'famicom',
      userId: 'bob',
    })
    await f.library.update(userTable).set({ libraryMode: libraryModeEnum.isolated }).where(eq(userTable.id, 'bob'))
    const url = inGameSaveUrl({ id: romId }, bytes)
    const data = Buffer.alloc(inGameSaveSize, 0x7e).toString('base64')
    await expectStatus(f.request(url), 404)
    await expectStatus(f.request(url, putSave(data, null)), 404)
    const saved = await expectStatus(f.request(url, putSave(data, null), 'bob'), 200)
    const { version } = syncedVersion.parse(await saved.json())
    assert.deepEqual(await savedJson(f.request(url, undefined, 'bob')), { data, version })

    const altered = Buffer.from(bytes)
    altered[12_000] = 0x11
    await writeFixture(f.root, `data/storage/${fileId}`, altered)
    await expectStatus(f.request(url, undefined, 'bob'), 409)
    await expectStatus(f.request(url, putSave(data, version), 'bob'), 409)
    const currentUrl = inGameSaveUrl({ id: romId }, altered)
    assert.deepEqual(await savedJson(f.request(currentUrl, undefined, 'bob')), {
      data: null,
      version: null,
    })

    const replacement = Buffer.from(bytes)
    replacement[1000] = 0x11
    const form = new FormData()
    form.set('file', new File([replacement], 'Private.nes'))
    form.set('platform', 'famicom')
    const replacedRom = z
      .object({ fileId: z.string(), id: z.string() })
      .parse(await savedJson(f.request('/roms', { body: form, method: 'POST' }, 'bob')))
    assert.equal(replacedRom.id, romId)
    assert.notEqual(replacedRom.fileId, fileId)
    await expectStatus(f.request(currentUrl, undefined, 'bob'), 409)
    const replaced = inGameSaveUrl({ id: romId }, replacement)
    assert.deepEqual(await savedJson(f.request(replaced, undefined, 'bob')), {
      data: null,
      version: null,
    })
    await rm(path.join(f.storage, replacedRom.fileId))
    await expectStatus(f.request(replaced, undefined, 'bob'), 404)
  })

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
    const deletion = await expectStatus(f.request(`/roms/${original.id}`, { method: 'DELETE' }), 404)
    assert.deepEqual(await deletion.json(), { message: 'ROM not found' })
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

  await it('keeps ROM core choices private, preserves other-core states, and restores inheritance', async (t) => {
    const f = await fixture(t, {
      'roms/famicom/Pulse.nes': 'alternate source',
      'roms/nes/Pulse.nes': 'original source',
    })
    const before = await sourceSnapshot(f.roms)
    const { roms } = await f.list()
    const game = roms.find((rom) => rom.mountedSource?.path === 'nes/Pulse.nes')
    const sibling = roms.find((rom) => rom.mountedSource?.path === 'famicom/Pulse.nes')
    assert.ok(game && sibling)
    assert.equal(game.fileName, sibling.fileName)
    for (const [index, core] of ['fceumm', 'nestopia'].entries()) {
      await f.library.insert(stateTable).values({
        core,
        createdAt: new Date(index),
        fileId: `${core}.state`,
        id: `${core}-state`,
        platform: 'nes',
        romId: game.id,
        thumbnailFileId: `${core}.png`,
        type: 'manual',
        userId: 'alice',
      })
    }

    const defaultPlayback = await f.playback(game.id)
    assert.equal(defaultPlayback.core, 'fceumm')
    assert.deepEqual(defaultPlayback.state, { core: 'fceumm', id: 'fceumm-state', playlist: null })
    const [alice, bob] = await Promise.all([
      expectStatus(f.setCore(game.id, 'nestopia'), 200),
      expectStatus(f.setCore(game.id, 'quicknes', 'bob'), 200),
    ])
    assert.deepEqual(await alice.json(), { core: 'nestopia' })
    assert.deepEqual(await bob.json(), { core: 'quicknes' })
    assert.deepEqual(await f.playback(game.id), {
      core: 'nestopia',
      gameCorePreference: { override: 'nestopia', platformCore: 'fceumm' },
      state: { core: 'nestopia', id: 'nestopia-state', playlist: null },
    })
    const otherPlayback = await f.playback(game.id, 'bob')
    assert.equal(otherPlayback.core, 'quicknes')
    assert.equal(otherPlayback.state, undefined)
    const siblingPlayback = await f.playback(sibling.id)
    assert.equal(siblingPlayback.core, 'fceumm')

    const reset = await expectStatus(f.setCore(game.id, null), 200)
    assert.deepEqual(await reset.json(), { core: null })
    assert.deepEqual(await f.playback(game.id), defaultPlayback)
    await expectStatus(
      f.request('/preference', {
        body: JSON.stringify({ emulator: { platform: { nes: { core: 'quicknes' } } } }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }),
      200,
    )
    const inheritedPlayback = await f.playback(game.id)
    assert.deepEqual(inheritedPlayback.gameCorePreference, { override: null, platformCore: 'quicknes' })
    await expectStatus(f.setCore(game.id, 'nestopia'), 200)
    const reselectedPlayback = await f.playback(game.id)
    assert.equal(reselectedPlayback.state?.id, 'nestopia-state')
    await f.library
      .update(romCorePreferenceTable)
      .set({ core: 'mgba' })
      .where(eq(romCorePreferenceTable.userId, 'alice'))
    const stale = await f.playback(game.id)
    assert.equal(stale.core, 'quicknes')
    assert.equal(stale.gameCorePreference?.override, null)
    assert.equal(stale.state, undefined)
    const bobPlayback = await f.playback(game.id, 'bob')
    assert.equal(bobPlayback.gameCorePreference?.override, 'quicknes')
    const states = await expectStatus(f.request(`/roms/${game.id}/states`), 200)
    assert.deepEqual(z.array(z.object({ id: z.string() })).parse(await states.json()), [
      { id: 'nestopia-state' },
      { id: 'fceumm-state' },
    ])
    assert.deepEqual(await sourceSnapshot(f.roms), before)
  })

  await it('rejects choices for hidden, unavailable, single-core and unsupported mounted games', async (t) => {
    const f = await fixture(t, {
      'roms/nes/Hidden.nes': 'hidden',
      'roms/nes/Missing.nes': 'removed',
      'roms/nes/Playable.nes': 'playable',
      'roms/nes/Unsupported.iso': 'unsupported format on a multi-core platform',
      'roms/psx/Single.chd': 'single core',
    })
    const { roms } = await f.list()
    const hidden = roms.find((rom) => rom.fileName === 'Hidden.nes')
    const missing = roms.find((rom) => rom.fileName === 'Missing.nes')
    const playable = roms.find((rom) => rom.fileName === 'Playable.nes')
    const unsupported = roms.find((rom) => rom.fileName === 'Unsupported.iso')
    const single = roms.find((rom) => rom.fileName === 'Single.chd')
    assert.ok(hidden && missing && playable && unsupported && single)
    await expectStatus(f.setCore(playable.id, '__proto__'), 400)
    await expectStatus(f.setCore(playable.id, 'mgba'), 422)
    const anonymous = await f.setCore(playable.id, 'nestopia', '')
    assert.equal(anonymous.ok, false)
    await expectStatus(f.setCore(unsupported.id, 'nestopia'), 422)
    await expectStatus(f.setCore(single.id, 'pcsx_rearmed'), 422)
    const unsupportedPlayback = await f.playback(unsupported.id)
    const singlePlayback = await f.playback(single.id)
    assert.equal(unsupportedPlayback.gameCorePreference, null)
    assert.equal(singlePlayback.gameCorePreference, null)

    await seedLegacyHiddenRom(f.library, hidden.id)
    await rm(path.join(f.roms, 'nes/Missing.nes'))
    await f.mounted.scan()
    await expectStatus(f.setCore(hidden.id, 'nestopia'), 404)
    await expectStatus(f.setCore(missing.id, 'nestopia'), 404)
    assert.deepEqual(await f.library.select().from(romCorePreferenceTable), [])
  })

  await it('edits shared metadata and art without writing source files', async (t) => {
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
    assert.deepEqual(await sourceSnapshot(f.roms), before)
  })

  await it('rejects mounted ROM deletion for all users without mutating a mixed batch or its history', async (t) => {
    const f = await fixture(t)
    process.env.RETROASSEMBLY_RUN_TIME_SHARED_LIBRARY_ONLY = 'false'
    t.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json([])))
    const {
      roms: [mounted],
    } = await f.list()
    const beforeSource = await sourceSnapshot(f.roms)
    const patch = new FormData()
    patch.set('gameName', 'Manually named mounted game')
    await expectStatus(f.request(`/roms/${mounted.id}`, { body: patch, method: 'PATCH' }), 200)
    const form = new FormData()
    const uploadBytes = createSyntheticNesRom()
    form.set('file', new File([Buffer.from(uploadBytes)], 'Owned upload.nes'))
    form.set('platform', 'nes')
    const upload = await expectStatus(f.request('/roms', { body: form, method: 'POST' }), 200)
    const uploaded = z.object({ fileId: z.string(), id: z.string() }).parse(await upload.json())
    for (const user of ['alice', 'bob']) {
      for (const id of [uploaded.id, mounted.id]) {
        const launch = new FormData()
        launch.set('core', 'fceumm')
        launch.set('rom', id)
        await expectStatus(f.request('/launch_records', { body: launch, method: 'POST' }, user), 200)
      }
    }
    const beforeRoms = await f.library.select().from(romTable)
    const beforeHistory = await f.library.select().from(launchRecordTable)
    const deletion = { method: 'DELETE' }
    const mountedPath = `/roms/${mounted.id}`
    const mountIsReadOnly = { message: 'Mounted ROMs are read-only and cannot be deleted.' }
    for (const user of ['alice', 'bob']) {
      for (const endpoint of [mountedPath, `/roms?ids=${mounted.id}`]) {
        const response = await expectStatus(f.request(endpoint, deletion, user), 403)
        assert.deepEqual(await response.json(), mountIsReadOnly)
      }
    }
    const mixed = await expectStatus(f.request(`/roms?ids=${uploaded.id},${mounted.id}`, deletion), 403)
    assert.deepEqual(await mixed.json(), mountIsReadOnly)
    const sharedUpload = await expectStatus(f.request(`/roms/${uploaded.id}`, deletion, 'bob'), 403)
    assert.deepEqual(await sharedUpload.json(), {
      message: 'You are using a shared library and cannot modify its contents.',
    })
    assert.deepEqual(await f.library.select().from(romTable), beforeRoms)
    assert.deepEqual(await f.library.select().from(launchRecordTable), beforeHistory)
    const uploadPath = path.join(f.storage, uploaded.fileId)
    assert.deepEqual(await readFile(uploadPath), Buffer.from(uploadBytes))

    await expectStatus(f.request(`${mountedPath}/launch_records`, deletion, 'bob'), 200)
    await expectStatus(f.request(`/roms?ids=${uploaded.id}`, deletion), 200)
    await expectStatus(f.request(`/roms/${uploaded.id}`), 404)
    await assert.rejects(readFile(uploadPath), { code: 'ENOENT' })
    for (const user of ['alice', 'bob']) {
      const { roms } = await f.list(user)
      assert.deepEqual(
        roms.map(({ gameName, id }) => ({ gameName, id })),
        [{ gameName: 'Manually named mounted game', id: mounted.id }],
      )
    }
    const activeHistory = await f.library
      .select()
      .from(launchRecordTable)
      .where(eq(launchRecordTable.status, statusEnum.normal))
    assert.deepEqual(activeHistory.map(({ romId, userId }) => `${userId}:${romId}`).toSorted(), [
      `alice:${mounted.id}`,
      `bob:${uploaded.id}`,
    ])
    assert.deepEqual(await sourceSnapshot(f.roms), beforeSource)
  })

  await it('does not update a ROM or its history if a mounted source is set after delete validation', async (t) => {
    const fileId = 'roms/nes/owned.nes'
    const f = await fixture(t, { ...defaultFiles, [`data/storage/${fileId}`]: 'synthetic upload' })
    process.env.RETROASSEMBLY_RUN_TIME_SHARED_LIBRARY_ONLY = 'false'
    const [mounted] = await f.library.select().from(romTable)
    assert.ok(mounted.mountedSource)
    const romId = 'owned-upload'
    await f.library
      .insert(romTable)
      .values({ fileId, fileName: 'Owned.nes', id: romId, platform: 'nes', userId: 'alice' })
    const launch = new FormData()
    launch.set('core', 'fceumm')
    launch.set('rom', romId)
    await expectStatus(f.request('/launch_records', { body: launch, method: 'POST' }), 200)
    const historyBefore = await f.library.select().from(launchRecordTable)
    const { $client } = f.library
    const prepare = $client.prepare.bind($client)
    t.mock.method($client, 'prepare', (query: string) => {
      if (query.startsWith('update "roms" set')) {
        prepare('UPDATE roms SET mounted_source = ? WHERE id = ?').run(JSON.stringify(mounted.mountedSource), romId)
      }
      return prepare(query)
    })

    await expectStatus(f.request(`/roms/${romId}`, { method: 'DELETE' }), 200)
    const [unchanged] = await f.library.select().from(romTable).where(eq(romTable.id, romId))
    assert.equal(unchanged.status, statusEnum.normal)
    assert.deepEqual(unchanged.mountedSource, mounted.mountedSource)
    assert.deepEqual(await f.library.select().from(launchRecordTable), historyBefore)
    assert.equal(await readFile(path.join(f.storage, fileId), 'utf8'), 'synthetic upload')
  })

  await it('allows only the oldest active account to restore a hidden mounted ROM without changing private activity', async (t) => {
    const f = await fixture(t, {
      ...defaultFiles,
      'bios/nes.pal': 'synthetic palette',
      'roms/NES/Visible.nes': 'visible',
    })
    const { roms } = await f.list()
    const rom = roms.find((candidate) => candidate.fileName === 'Nested/雪 & Hero.NES')
    const visible = roms.find((candidate) => candidate.fileName === 'Visible.nes')
    assert.ok(rom)
    assert.ok(visible)
    const listUrl = '/mounted-library/hidden'
    const restoreUrl = `${listUrl}/${rom.id}/restore`
    const restore = { method: 'POST' }
    const before = { bios: await sourceSnapshot(f.bios), roms: await sourceSnapshot(f.roms) }
    await f.library.insert(userTable).values({
      createdAt: new Date(0),
      status: statusEnum.deleted,
      username: 'Inactive former admin',
    })
    await f.library.insert(romTable).values({
      fileId: 'roms/nes/deleted-upload.nes',
      fileName: 'Deleted upload.nes',
      id: 'deleted-upload',
      platform: 'nes',
      status: statusEnum.deleted,
      userId: 'alice',
    })
    const patch = new FormData()
    patch.set('gameName', 'Corrected mounted title')
    patch.set('gameDescription', 'App-owned correction')
    await expectStatus(f.request(`/roms/${rom.id}`, { body: patch, method: 'PATCH' }, 'bob'), 200)
    const art = new FormData()
    art.set('file', new File(['app-owned artwork'], 'cover.png', { type: 'image/png' }))
    const artResponse = await expectStatus(
      f.request(`/roms/${rom.id}/boxart`, { body: art, method: 'POST' }, 'bob'),
      200,
    )
    const artId = z.string().parse(await artResponse.json())
    await expectStatus(
      f.request('/favorites', {
        body: JSON.stringify({ romId: rom.id }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }),
      200,
    )
    const launchForm = new FormData()
    launchForm.set('rom', rom.id)
    launchForm.set('core', 'fceumm')
    for (const user of ['alice', 'bob']) {
      await expectStatus(f.request('/launch_records', { body: launchForm, method: 'POST' }, user), 200)
    }
    const stateForm = new FormData()
    stateForm.set('core', 'fceumm')
    stateForm.set('rom', rom.id)
    stateForm.set('state', new Blob(['private state']))
    stateForm.set('thumbnail', new Blob(['private thumbnail']))
    stateForm.set('type', 'manual')
    const stateResponse = await expectStatus(f.request('/states', { body: stateForm, method: 'POST' }, 'bob'), 200)
    const state = z.object({ fileId: z.string(), id: z.string() }).parse(await stateResponse.json())

    await seedLegacyHiddenRom(f.library, rom.id)
    await f.mounted.scan()
    for (const user of ['alice', 'bob']) {
      const { roms: visibleRoms } = await f.list(user)
      assert.deepEqual(
        visibleRoms.map(({ id }) => id),
        [visible.id],
      )
      await expectStatus(f.request(`/roms/${rom.id}`, {}, user), 404)
      const deletion = await expectStatus(f.request(`/roms/${rom.id}`, { method: 'DELETE' }, user), 404)
      assert.deepEqual(await deletion.json(), { message: 'ROM not found' })
    }
    await expectStatus(f.request(`/roms/${rom.id}/content`), 404)
    await expectStatus(f.request(`/files/${encodeURIComponent(rom.fileId)}`), 404)
    await expectStatus(f.request(listUrl, {}, 'bob'), 403)
    await expectStatus(f.request(restoreUrl, restore, 'bob'), 403)
    await expectStatus(f.request(listUrl, {}, ''), 400)
    await expectStatus(f.request(restoreUrl, restore, ''), 400)

    const hidden = await expectStatus(f.request(listUrl), 200)
    assert.equal(hidden.headers.get('Cache-Control'), 'private, no-store')
    assert.deepEqual(await hidden.json(), [
      { available: true, fileName: rom.fileName, gameName: 'Corrected mounted title', id: rom.id, platform: 'nes' },
    ])
    for (const id of ['deleted-upload', visible.id, 'missing']) {
      await expectStatus(f.request(`${listUrl}/${id}/restore`, restore), 404)
    }
    process.env.RETROASSEMBLY_RUN_TIME_ENABLE_SHARED_ROM_LIBRARY = 'false'
    await expectStatus(f.request(listUrl), 404)
    await expectStatus(f.request(restoreUrl, restore), 404)
    process.env.RETROASSEMBLY_RUN_TIME_ENABLE_SHARED_ROM_LIBRARY = 'true'

    const restored = await expectStatus(f.request(restoreUrl, restore), 200)
    assert.deepEqual(await restored.json(), { id: rom.id })
    const empty = await expectStatus(f.request(listUrl), 200)
    assert.deepEqual(await empty.json(), [])
    await expectStatus(f.request(restoreUrl, restore), 404)
    assert.equal(f.mounted.getStatus().indexed, 2)
    for (const user of ['alice', 'bob']) {
      const response = await expectStatus(f.request(`/roms/${rom.id}`, {}, user), 200)
      const restoredRom = romResponse.extend({ gameDescription: z.string() }).parse(await response.json())
      assert.equal(restoredRom.id, rom.id)
      assert.equal(restoredRom.fileId, rom.fileId)
      assert.equal(restoredRom.gameName, 'Corrected mounted title')
      assert.equal(restoredRom.gameDescription, 'App-owned correction')
      assert.equal(restoredRom.gameBoxartFileIds, artId)
      assert.equal(Boolean(restoredRom.isFavorite), user === 'alice')
      const history = await expectStatus(f.request('/launch_records', {}, user), 200)
      const historyRoms = z.object({ roms: z.array(z.object({ id: z.string() })) }).parse(await history.json()).roms
      assert.deepEqual(historyRoms, [{ id: rom.id }])
    }
    const cover = await expectStatus(f.request(`/files/${encodeURIComponent(artId)}`), 200)
    assert.equal(await cover.text(), 'app-owned artwork')
    const stateUrl = `/files/${encodeURIComponent(state.fileId)}`
    await expectStatus(f.request(stateUrl), 404)
    const ownedState = await expectStatus(f.request(stateUrl, {}, 'bob'), 200)
    assert.equal(await ownedState.text(), 'private state')
    assert.deepEqual({ bios: await sourceSnapshot(f.bios), roms: await sourceSnapshot(f.roms) }, before)
  })

  await it('keeps changed, missing, and unreconciled sources hidden until a valid rescan', async (t) => {
    const f = await fixture(t)
    const {
      roms: [rom],
    } = await f.list()
    assert.ok(rom.mountedSource)
    const listUrl = '/mounted-library/hidden'
    const restoreUrl = `${listUrl}/${rom.id}/restore`
    const restore = { method: 'POST' }
    await seedLegacyHiddenRom(f.library, rom.id)
    await writeFixture(f.roms, rom.mountedSource.path, 'new synthetic bytes')
    const changed = await expectStatus(f.request(restoreUrl, restore), 409)
    assert.match(await changed.text(), /file changed/u)

    await rm(path.join(f.roms, rom.mountedSource.path))
    const missing = await expectStatus(f.request(restoreUrl, restore), 503)
    assert.match(await missing.text(), /source unavailable or unsafe/u)
    await f.mounted.scan()
    const hidden = await expectStatus(f.request(listUrl), 200)
    const entry = { available: false, fileName: rom.fileName, gameName: null, id: rom.id, platform: 'nes' }
    assert.deepEqual(await hidden.json(), [entry])

    await writeFixture(f.roms, rom.mountedSource.path, 'returned synthetic bytes')
    const unreconciled = await expectStatus(f.request(restoreUrl, restore), 409)
    assert.match(await unreconciled.text(), /unavailable in the index/u)
    await expectStatus(f.request(`/roms/${rom.id}`), 404)
    await f.mounted.scan()
    const rescanned = await expectStatus(f.request(listUrl), 200)
    assert.deepEqual(await rescanned.json(), [{ ...entry, available: true }])
    await expectStatus(f.request(restoreUrl, restore), 200)
    const content = await expectStatus(f.request(`/roms/${rom.id}/content`), 200)
    assert.equal(await content.text(), 'returned synthetic bytes')
  })

  await it('does not restore a source reconciled as unavailable while the restore is in flight', async (t) => {
    const f = await fixture(t)
    const {
      roms: [rom],
    } = await f.list()
    assert.ok(rom.mountedSource)
    const filename = path.join(f.roms, rom.mountedSource.path)
    await seedLegacyHiddenRom(f.library, rom.id)
    trackFileHandles(t, function reconcileAfterFileCheck(handle) {
      const { close } = handle
      t.mock.method(handle, 'close', async function removeAndScan() {
        await close()
        await rm(filename)
        await f.mounted.scan()
      })
    })
    const response = await expectStatus(f.request(`/mounted-library/hidden/${rom.id}/restore`, { method: 'POST' }), 409)
    assert.match(await response.text(), /hidden mounted ROM changed/iu)
    const hidden = await expectStatus(f.request('/mounted-library/hidden'), 200)
    assert.deepEqual(await hidden.json(), [
      { available: false, fileName: rom.fileName, gameName: null, id: rom.id, platform: 'nes' },
    ])
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

  await it('closes mounted BIOS handles after responses, HEAD probes, stream cancellation, and request aborts', async (t) => {
    const palette = new Uint8Array(192).fill(37)
    const f = await fixture(t, { ...defaultFiles, 'bios/nes.pal': palette })
    const before = await sourceSnapshot(f.bios)
    const opened = trackFileHandles(t)
    const fileId = getMountedFileId('bios', 'nes.pal')
    for (const method of ['GET', 'HEAD']) {
      const response = await f.request(`/files/${encodeURIComponent(fileId)}`, { method })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('Content-Length'), `${palette.byteLength}`)
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), method === 'HEAD' ? new Uint8Array(0) : palette)
    }
    const cancelled = await f.mounted.readFile(fileId)
    await cancelled.body.cancel('browser left')
    const abort = new AbortController()
    const abandoned = await f.request(`/files/${encodeURIComponent(fileId)}`, { signal: abort.signal })
    abort.abort()
    await assert.rejects(abandoned.arrayBuffer(), { name: 'AbortError' })
    assert.equal(opened.length, 4)
    for (const { closeCalls, handle } of opened) {
      assert.equal(handle.fd, -1)
      assert.equal(closeCalls, 1)
    }
    assert.deepEqual(await sourceSnapshot(f.bios), before)
  })

  await it('closes mounted BIOS and ROM handles before reporting response read failures', async (t) => {
    const f = await fixture(t, { ...defaultFiles, 'bios/nes.pal': 'synthetic palette' })
    const readError = new Error('Synthetic mounted read failure')
    function rejectRead() {
      return Promise.reject(readError)
    }
    const opened = trackFileHandles(t, function failRead(handle) {
      t.mock.method(handle, 'read', rejectRead)
    })
    for (const fileId of [getMountedFileId('bios', 'nes.pal'), getMountedFileId('roms', 'NES/Nested/雪 & Hero.NES')]) {
      const file = await f.mounted.readFile(fileId)
      await assert.rejects(new Response(file.body).arrayBuffer(), readError)
    }
    assert.equal(opened.length, 2)
    for (const { closeCalls, handle } of opened) {
      assert.equal(handle.fd, -1)
      assert.equal(closeCalls, 1)
    }
  })

  await it('bounds mounted ROM chunks and closes once when cancelling an in-flight response read', async (t) => {
    const f = await fixture(t, { 'roms/NES/Large.nes': new Uint8Array(1024 * 1024).fill(42) })
    const started = Promise.withResolvers<undefined>()
    const finished = Promise.withResolvers<undefined>()
    let deferRead = false
    async function readAfterCancellation() {
      started.resolve(undefined)
      await finished.promise
      throw new Error('Pending mounted read failed after cancellation')
    }
    const opened = trackFileHandles(t, function delayRead(handle) {
      if (deferRead) {
        t.mock.method(handle, 'read', readAfterCancellation)
      }
    })
    const fileId = getMountedFileId('roms', 'NES/Large.nes')
    const file = await f.mounted.readFile(fileId)
    const reader = file.body.getReader()
    const first = await reader.read()
    assert.ok(first.value)
    assert.ok(first.value.byteLength > 0 && first.value.byteLength <= 64 * 1024)
    assert.ok(first.value.every((byte) => byte === 42))
    await reader.cancel('only the first chunk was needed')
    reader.releaseLock()

    deferRead = true
    const pendingFile = await f.mounted.readFile(fileId)
    const pendingReader = pendingFile.body.getReader()
    const pending = pendingReader.read()
    await started.promise
    const cancellation = pendingReader.cancel('browser disconnected')
    finished.resolve(undefined)
    await cancellation
    assert.deepEqual(await pending, { done: true, value: undefined })
    pendingReader.releaseLock()
    assert.equal(opened.length, 2)
    for (const { closeCalls, handle } of opened) {
      assert.equal(handle.fd, -1)
      assert.equal(closeCalls, 1)
    }
  })

  await it('closes an opened mounted BIOS handle when response stream setup fails', async (t) => {
    const f = await fixture(t, { ...defaultFiles, 'bios/nes.pal': 'synthetic palette' })
    const opened = trackFileHandles(t)
    const setupError = new Error('Synthetic stream setup failure')
    class FailingReadableStream<Chunk> extends ReadableStream<Chunk> {
      constructor() {
        super()
        throw setupError
      }
    }
    t.mock.property(globalThis, 'ReadableStream', FailingReadableStream)
    await assert.rejects(f.mounted.readFile(getMountedFileId('bios', 'nes.pal')), {
      cause: setupError,
      status: 503,
    })
    assert.equal(opened.length, 1)
    assert.equal(opened[0].handle.fd, -1)
    assert.equal(opened[0].closeCalls, 1)
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
    await expectStatus(f.setCore(ownRom.id, 'nestopia', 'bob'), 404)
    await expectStatus(f.setCore(ownRom.id, 'nestopia'), 200)
    const ownedPlayback = await f.playback(ownRom.id)
    assert.equal(ownedPlayback.core, 'nestopia')
    await f.library.update(userTable).set({ libraryMode: libraryModeEnum.shared }).where(eq(userTable.id, 'bob'))
    process.env.RETROASSEMBLY_RUN_TIME_ENABLE_SHARED_ROM_LIBRARY = 'true'
    process.env.RETROASSEMBLY_RUN_TIME_SHARED_LIBRARY_ONLY = 'false'
    await expectStatus(f.setCore(ownRom.id, 'quicknes', 'bob'), 200)
    const [guestPlayback, ownerPlayback] = await Promise.all([f.playback(ownRom.id, 'bob'), f.playback(ownRom.id)])
    assert.equal(guestPlayback.core, 'quicknes')
    assert.equal(ownerPlayback.core, 'nestopia')
    await f.library.update(userTable).set({ libraryMode: libraryModeEnum.isolated }).where(eq(userTable.id, 'bob'))
    process.env.RETROASSEMBLY_RUN_TIME_ENABLE_SHARED_ROM_LIBRARY = 'false'
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
    await expectStatus(f.request(`/roms/${ownRom.id}`, { method: 'DELETE' }), 200)
    await expectStatus(f.request(`/roms/${ownRom.id}`), 404)
    await assert.rejects(readFile(path.join(f.storage, ownRom.fileId)), { code: 'ENOENT' })
  })

  await it('enables a previously unsupported Virtual Boy BIN on rescan without replacing the mounted ROM', async (t) => {
    const bytes = 'Original synthetic VB cartridge bytes'
    const f = await fixture(t, {
      'roms/ps1/Unsupported.bin': bytes,
      'roms/vb/Hidden.bin': bytes,
      'roms/virtualboy/Signal.BIN': bytes,
    })
    const before = await sourceSnapshot(f.roms)
    const roms = f.library.select().from(romTable).all()
    const hidden = roms.find(({ fileName }) => fileName === 'Hidden.bin')
    const game = roms.find(({ fileName }) => fileName === 'Signal.BIN')
    const psx = roms.find(({ fileName }) => fileName === 'Unsupported.bin')
    assert.ok(game?.mountedSource && hidden?.mountedSource && psx?.mountedSource)
    const unsupportedReason =
      'The .BIN format is not supported for vb by this browser integration. The source is indexed without conversion and cannot be launched.'
    const manual = {
      gameBoxartFileIds: 'attachments/alice/vb-cover.png',
      gameDescription: 'Manual description',
      gameName: 'Manual title',
    }
    const source = {
      ...game.mountedSource,
      artwork: 'manual' as const,
      metadata: 'manual' as const,
      unsupportedReason,
    }
    const identification = await getMountedIdentification({ ...game, mountedSource: source }, f.configuration.roms)
    assert.equal(identification.mode, 'name-only')
    await writeFixture(f.storage, manual.gameBoxartFileIds, 'app-owned artwork')
    f.library
      .update(romTable)
      .set({ ...manual, mountedSource: { ...source, identification } })
      .where(eq(romTable.id, game.id))
      .run()
    f.library
      .update(romTable)
      .set({ mountedSource: { ...hidden.mountedSource, unsupportedReason } })
      .where(eq(romTable.id, hidden.id))
      .run()
    await seedLegacyHiddenRom(f.library, hidden.id)

    function launch(id: string, core = 'mednafen_vb', user = 'alice') {
      const body = new FormData()
      body.set('core', core)
      body.set('rom', id)
      return f.request('/launch_records', { body, method: 'POST' }, user)
    }

    const blocked = await expectStatus(launch(game.id), 422)
    assert.deepEqual(await blocked.json(), { message: unsupportedReason })
    await expectStatus(f.request('/mounted-library', { method: 'POST' }), 200)
    const refreshed = f.library.select().from(romTable).where(eq(romTable.id, game.id)).get()
    assert.ok(refreshed?.mountedSource)
    assert.partialDeepStrictEqual(refreshed, {
      ...manual,
      fileId: game.fileId,
      id: game.id,
      mountedSource: {
        artwork: 'manual',
        available: true,
        metadata: 'manual',
        path: source.path,
        revision: source.revision,
      },
      platform: 'vb',
    })
    assert.equal(refreshed.mountedSource.unsupportedReason, undefined)
    const hashed = await getMountedIdentification(refreshed, f.configuration.roms)
    assert.equal(hashed.mode, 'file')
    assert.equal(hashed.md5, createHash('md5').update(bytes).digest('hex'))
    assert.equal(await readFile(path.join(f.storage, manual.gameBoxartFileIds), 'utf8'), 'app-owned artwork')

    const contentUrl = `/roms/${game.id}/content`
    await expectStatus(f.request(contentUrl, {}, ''), 400)
    await expectStatus(launch(game.id, 'mednafen_vb', ''), 400)
    const playback = await f.playback(game.id)
    assert.equal(playback.core, 'mednafen_vb')
    await expectStatus(launch(game.id), 200)
    const launched = f.library.select().from(launchRecordTable).get()
    assert.partialDeepStrictEqual(launched, { core: 'mednafen_vb', platform: 'vb', romId: game.id, userId: 'alice' })
    const content = await expectStatus(f.request(contentUrl), 200)
    assert.equal(content.headers.get('ETag'), `"${source.revision}"`)
    assert.equal(await content.text(), bytes)
    await expectStatus(launch(hidden.id), 404)
    await expectStatus(f.request(`/roms/${hidden.id}/content`), 404)
    await expectStatus(launch(psx.id, 'pcsx_rearmed'), 422)
    assert.deepEqual(await sourceSnapshot(f.roms), before)
  })

  await it('enables a mounted PlayStation PBP with a lead-in-inclusive TOC on a complete read-only rescan', async (t) => {
    const { bytes, endPatch } = createSyntheticPsxPbp({ layout: 'pop-fe' })
    const sourcePath = 'ps1/Legacy game.PBP'
    const hiddenPath = 'ps1/Hidden.PBP'
    const f = await fixture(t, {
      'roms/PSX/First.chd': 'synthetic first CHD',
      'roms/PSX/Game.m3u': 'First.chd\nSecond.chd\n',
      'roms/PSX/Second.chd': 'synthetic second CHD',
      [`roms/${hiddenPath}`]: bytes,
      [`roms/${sourcePath}`]: bytes,
    })
    const sourceFile = path.join(f.roms, sourcePath)
    await fs.chmod(sourceFile, 0o444)
    await f.mounted.scan()
    const before = await sourceSnapshot(f.roms)
    const roms = f.library.select().from(romTable).all()
    const pbp = roms.find(({ fileId }) => fileId === getMountedFileId('roms', sourcePath))
    const hidden = roms.find(({ fileId }) => fileId === getMountedFileId('roms', hiddenPath))
    const chd = roms.find(({ fileName }) => fileName === 'First.chd')
    const playlist = roms.find(({ fileName }) => fileName === 'Game.m3u')
    assert.ok(pbp?.mountedSource && hidden?.mountedSource && chd && playlist?.mountedSource?.playlist)
    const legacyReason = 'The PlayStation PBP is malformed or truncated.'
    const manual = {
      gameBoxartFileIds: 'attachments/alice/legacy-cover.png',
      gameDescription: 'My description',
      gameName: 'My title',
    }
    const identification = {
      ...(await getMountedIdentification(pbp, f.configuration.roms)),
      confidence: 'filename' as const,
    }
    assert.equal(identification.mode, 'name-only')
    assert.equal(identification.md5, undefined)
    await writeFixture(f.storage, manual.gameBoxartFileIds, 'app-owned artwork')
    await f.library
      .update(romTable)
      .set({
        ...manual,
        mountedSource: {
          ...pbp.mountedSource,
          artwork: 'manual',
          identification,
          metadata: 'manual',
          pbpEndPatch: undefined,
          unsupportedReason: legacyReason,
        },
      })
      .where(eq(romTable.id, pbp.id))
    await f.library
      .update(romTable)
      .set({
        mountedSource: { ...hidden.mountedSource, pbpEndPatch: undefined, unsupportedReason: legacyReason },
        status: statusEnum.deleted,
      })
      .where(eq(romTable.id, hidden.id))

    function launch(id: string) {
      const body = new FormData()
      body.set('core', 'pcsx_rearmed')
      body.set('rom', id)
      return f.request('/launch_records', { body, method: 'POST' })
    }

    let failing = true
    let failed = false
    const opened = trackFileHandles(t, (handle, filename) => {
      if (failing && filename === sourceFile) {
        t.mock.method(handle, 'read', function fail() {
          failed = true
          return Promise.reject(new Error('Fixture PBP read interrupted'))
        })
      }
    })
    await expectStatus(f.request('/mounted-library', { method: 'POST' }), 503)
    const stale = await expectStatus(launch(pbp.id), 422)
    assert.deepEqual(await stale.json(), { message: legacyReason })
    assert.ok(failed)
    assert.ok(opened.every(({ closeCalls }) => closeCalls === 1))
    failing = false

    await expectStatus(f.request('/mounted-library', { method: 'POST' }), 200)
    const detail = await expectStatus(f.request(`/roms/${pbp.id}`), 200)
    const refreshed = romResponse.extend({ gameDescription: z.string() }).parse(await detail.json())
    assert.ok(refreshed.mountedSource)
    assert.equal(refreshed.mountedSource.unsupportedReason, undefined)
    assert.deepEqual(refreshed.mountedSource.pbpEndPatch, endPatch)
    assert.equal(refreshed.mountedSource.playlist, undefined)
    assert.equal(refreshed.mountedSource.revision, pbp.mountedSource.revision)
    assert.equal(refreshed.mountedSource.metadata, 'manual')
    assert.equal(refreshed.mountedSource.artwork, 'manual')
    assert.equal(refreshed.id, pbp.id)
    assert.equal(refreshed.fileId, pbp.fileId)
    assert.equal(refreshed.gameName, manual.gameName)
    assert.equal(refreshed.gameDescription, manual.gameDescription)
    assert.equal(refreshed.gameBoxartFileIds, manual.gameBoxartFileIds)
    assert.equal(await readFile(path.join(f.storage, manual.gameBoxartFileIds), 'utf8'), 'app-owned artwork')
    const updated = f.library.select().from(romTable).where(eq(romTable.id, pbp.id)).get()
    assert.ok(updated?.mountedSource)
    assert.deepEqual(updated.mountedSource.identification, identification)
    await f.library
      .update(romTable)
      .set({ mountedSource: { ...updated.mountedSource, pbpEndPatch: undefined } })
      .where(eq(romTable.id, pbp.id))
    await f.mounted.scan()
    const repaired = f.library.select().from(romTable).where(eq(romTable.id, pbp.id)).get()
    assert.deepEqual(repaired?.mountedSource?.pbpEndPatch, endPatch)
    const playback = await f.playback(pbp.id)
    assert.equal(playback.core, 'pcsx_rearmed')
    await expectStatus(launch(pbp.id), 200)
    const launched = f.library.select().from(launchRecordTable).where(eq(launchRecordTable.romId, pbp.id)).get()
    assert.partialDeepStrictEqual(launched, { core: 'pcsx_rearmed', platform: 'psx', romId: pbp.id, userId: 'alice' })
    const stillHidden = f.library.select().from(romTable).where(eq(romTable.id, hidden.id)).get()
    assert.equal(stillHidden?.status, statusEnum.deleted)
    assert.deepEqual(stillHidden?.mountedSource?.pbpEndPatch, endPatch)
    assert.equal(stillHidden?.mountedSource?.unsupportedReason, undefined)
    await expectStatus(f.request(`/roms/${hidden.id}/content`), 404)
    const fileUrl = `/files/${encodeURIComponent(pbp.fileId)}`
    await expectStatus(f.request(fileUrl, {}, ''), 400)
    for (const url of [fileUrl, `/roms/${pbp.id}/content`]) {
      const read = await expectStatus(f.request(url, {}, 'bob'), 200)
      assert.equal(read.headers.get('ETag'), `"${pbp.mountedSource.revision}"`)
      assert.deepEqual(Buffer.from(await read.arrayBuffer()), bytes)
    }
    await expectStatus(launch(chd.id), 200)
    await expectStatus(launch(playlist.id), 200)
    const discUrl = `/roms/${playlist.id}/discs/2?revision=${playlist.mountedSource.playlist.revision}`
    const disc = await expectStatus(f.request(discUrl), 200)
    assert.equal(await disc.text(), 'synthetic second CHD')
    assert.deepEqual(await sourceSnapshot(f.roms), before)
    await rename(sourceFile, `${sourceFile}.old`)
    await symlink(path.join(f.roms, 'PSX/First.chd'), sourceFile)
    await expectStatus(f.request(fileUrl), 503)
    await rm(sourceFile)
    await writeFile(sourceFile, 'replacement PBP')
    await expectStatus(f.request(fileUrl, { method: 'HEAD' }), 409)
    await expectStatus(f.request('/mounted-library', { method: 'POST' }), 200)
    await expectStatus(f.request(fileUrl), 422)
    const replaced = f.library.select().from(romTable).where(eq(romTable.id, pbp.id)).get()
    assert.equal(replaced?.mountedSource?.pbpEndPatch, undefined)
    for (const extension of ['.bin', '.cue', '.iso', '.m3u8']) {
      assert.equal(getMountedFormat('psx', extension)?.supported, false, extension)
    }
    assert.equal(resolveMountedPlatform('shadps4'), undefined)
  })

  await it('keeps unsupported or malformed PBP entries indexed without serving them as PlayStation discs', async (t) => {
    const { bytes, endPatch } = createSyntheticPsxPbp()
    const { bytes: leadInBytes } = createSyntheticPsxPbp({ layout: 'pop-fe' })
    const psar = bytes.readUInt32LE(36)
    const index = psar + 0x40_00
    const leadOut = psar + 0x8_00 + 27
    function variant(edit: (copy: Buffer) => void, source = bytes) {
      const copy = Buffer.from(source)
      edit(copy)
      return copy
    }
    const invalid = {
      badHeader: [Buffer.alloc(60), /does not have a PBP header/u],
      badOffset: [variant((copy) => copy.writeUInt32LE(copy.length + 1, 36)), /malformed or truncated/u],
      badToc: [variant((copy) => copy.fill(0xfa, psar + 0x8_11, psar + 0x8_12)), /invalid disc table/u],
      corruptBlock: [
        variant((copy) => copy.fill(0xff, psar + 0x10_00_00, psar + 0x10_00_01)),
        /unreadable disc blocks/u,
      ],
      discontinuousIndex: [variant((copy) => copy.writeUInt32LE(0, index + 32)), /invalid block range/u],
      earlyTerminator: [
        variant((copy) => copy.fill(0, endPatch.offset - 32, endPatch.offset), leadInBytes),
        /block index is too short/u,
      ],
      greatlyShortenedIndex: [
        variant((copy) => copy.fill(0, index + 2 * 32, endPatch.offset), leadInBytes),
        /block index is too short/u,
      ],
      largeBlock: [variant((copy) => copy.writeUInt32LE(16 * 2352 + 101, index + 4)), /invalid block range/u],
      leadOutAheadOfIndex: [variant((copy) => copy.set([0, 6, 5], leadOut), leadInBytes), /block index is too short/u],
      leadOutBetweenConventions: [
        variant((copy) => copy.set([0, 5, 0x63], leadOut), leadInBytes),
        /block index is too short/u,
      ],
      multiDisc: [variant((copy) => copy.write('PSTITLEIMG', psar)), /Multi-disc PlayStation PBP/u],
      nonDisc: [variant((copy) => copy.write('NotADisc!!', psar)), /does not contain a supported single-disc/u],
      nonzeroPadding: [variant((copy) => copy.writeUInt8(1, endPatch.offset + 8)), /invalid final block index/u],
      nonzeroPaddingAfterTerminator: [
        variant((copy) => copy.writeUInt8(1, endPatch.offset + 32)),
        /invalid final block index/u,
      ],
      protected: [variant((copy) => copy.write('\0PGD', psar + 0x4_00)), /Protected PlayStation PBP/u],
      psp: [
        variant((copy) => {
          copy.write('PSISOIMG0000', 40)
          copy.write('NPUMDIMG', psar)
        }),
        /PSP PBP/u,
      ],
      stored: [createSyntheticPsxPbp({ compressed: false }).bytes, /Uncompressed blocks/u],
      storedWithFlag: [createSyntheticPsxPbp({ compressed: false, layout: 'pop-fe' }).bytes, /Uncompressed blocks/u],
      trackPastLeadOut: [
        variant((copy) => copy.set([0, 4, 0], psar + 0x8_00 + 33), leadInBytes),
        /block index is too short/u,
      ],
      truncated: [leadInBytes.subarray(0, -1), /invalid block range/u],
      wrongEnd: [
        variant((copy) => copy.writeUInt32LE(endPatch.end - 1, endPatch.offset)),
        /invalid final block index/u,
      ],
    } as const
    const explicit = variant((copy) => copy.writeUInt32LE(endPatch.end, endPatch.offset))
    const exactLeadIn = variant((copy) => copy.set([0, 6, 4], leadOut), leadInBytes)
    const f = await fixture(t, {
      ...Object.fromEntries(Object.entries(invalid).map(([name, [pbp]]) => [`roms/PSX/${name}.pbp`, pbp])),
      'roms/nes/Not a PlayStation mount.pbp': bytes,
      'roms/PSX/Exact lead-in.pbp': exactLeadIn,
      'roms/PSX/Explicit end.pbp': explicit,
      'roms/PSX/First.chd': 'standalone CHD',
      'roms/PSX/Good.pbp': bytes,
      'roms/PSX/Mixed.m3u': 'First.chd\nGood.pbp\n',
    })
    const { roms } = await f.list()
    assert.equal(f.mounted.getStatus().unsupported, Object.keys(invalid).length + 2)
    for (const [name, [, reason]] of Object.entries(invalid)) {
      const rom = roms.find(({ fileName }) => fileName === `${name}.pbp`)
      assert.ok(rom?.mountedSource?.unsupportedReason, name)
      assert.match(rom.mountedSource.unsupportedReason, reason, name)
      assert.equal(rom.mountedSource.pbpEndPatch, undefined, name)
      const form = new FormData()
      form.set('core', 'pcsx_rearmed')
      form.set('rom', rom.id)
      await expectStatus(f.request('/launch_records', { body: form, method: 'POST' }), 422)
      await expectStatus(f.request(`/roms/${rom.id}/content`), 422)
    }
    const valid = roms.find(({ fileName }) => fileName === 'Good.pbp')
    assert.ok(valid?.mountedSource)
    assert.equal(valid.mountedSource.unsupportedReason, undefined)
    assert.deepEqual(valid.mountedSource.pbpEndPatch, endPatch)
    const atBoundary = roms.find(({ fileName }) => fileName === 'Exact lead-in.pbp')
    assert.ok(atBoundary?.mountedSource)
    assert.equal(atBoundary.mountedSource.unsupportedReason, undefined)
    assert.deepEqual(atBoundary.mountedSource.pbpEndPatch, endPatch)
    const explicitEnd = roms.find(({ fileName }) => fileName === 'Explicit end.pbp')
    assert.ok(explicitEnd?.mountedSource)
    assert.equal(explicitEnd.mountedSource.unsupportedReason, undefined)
    assert.equal(explicitEnd.mountedSource.pbpEndPatch, undefined)
    const explicitContent = await expectStatus(f.request(`/roms/${explicitEnd.id}/content`), 200)
    assert.deepEqual(Buffer.from(await explicitContent.arrayBuffer()), explicit)
    assert.deepEqual(roms.find(({ fileName }) => fileName === 'Mixed.m3u')?.mountedSource?.playlistIssue, {
      code: 'Format',
      line: 2,
    })
    assert.match(
      roms.find(({ fileName }) => fileName === 'Not a PlayStation mount.pbp')?.mountedSource?.unsupportedReason || '',
      /not supported/u,
    )

    process.env.RETROASSEMBLY_RUN_TIME_SHARED_LIBRARY_ONLY = 'false'
    const upload = new FormData()
    upload.set('platform', 'psx')
    upload.set('file', new File([bytes], 'Good.pbp'))
    const rejectedUpload = await expectStatus(f.request('/roms', { body: upload, method: 'POST' }), 400)
    assert.deepEqual(await rejectedUpload.json(), { message: 'File extension .pbp is not supported for platform psx' })
  })

  await it('patches just the virtual PBP terminator and refuses mismatched revisions or bytes', async (t) => {
    const { bytes, endPatch } = createSyntheticPsxPbp()
    const source = { fileId: getMountedFileId('roms', 'ps1/Fixture.PBP'), patch: endPatch, revision: 'a'.repeat(64) }
    const expected = Buffer.from(bytes)
    expected.writeUInt32LE(endPatch.end, endPatch.offset)
    let responseBytes = bytes
    let etag = `"${source.revision}"`
    const controller = new AbortController()
    t.mock.method(globalThis, 'fetch', function fetchFixture(input, options) {
      assert.ok(String(input).endsWith(`/api/v1/files/${encodeURIComponent(source.fileId)}`))
      assert.equal(options?.signal, controller.signal)
      return Promise.resolve(new Response(responseBytes, { headers: { etag } }))
    })
    const blob = await fetchMountedPbp(source, controller.signal)
    assert.deepEqual(Buffer.from(await blob.arrayBuffer()), expected)
    assert.equal(bytes.readUInt32LE(endPatch.offset), 0)
    etag = `"${'b'.repeat(64)}"`
    await assert.rejects(fetchMountedPbp(source, controller.signal), /unavailable or changed/u)
    etag = `"${source.revision}"`
    responseBytes = expected
    await assert.rejects(fetchMountedPbp(source, controller.signal), /zero-padded terminator/u)
    await assert.rejects(
      fetchMountedPbp({ ...source, patch: { ...endPatch, offset: bytes.length - 4 } }, controller.signal),
      /Invalid mounted PlayStation PBP end offset/u,
    )
  })

  await it('cancels a pending patched PBP download without handing incomplete content to Nostalgist', async (t) => {
    const { endPatch } = createSyntheticPsxPbp()
    const source = { fileId: getMountedFileId('roms', 'ps1/Fixture.PBP'), patch: endPatch, revision: 'a'.repeat(64) }
    const requested = Promise.withResolvers<AbortSignal>()
    t.mock.method(globalThis, 'fetch', function waitForAbort(_input, options) {
      const { signal } = options ?? {}
      assert.ok(signal)
      requested.resolve(signal)
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Fixture download aborted', 'AbortError')), {
          once: true,
        })
      })
    })
    const preparation = createMountedPbpPreparation(source)
    const playback = preparation.prepare({ core: 'pcsx_rearmed', rom: [] }, 'Fixture.PBP')
    const cancellation = assert.rejects(playback, { name: 'AbortError' })
    const signal = await requested.promise
    preparation.cancel()
    await cancellation
    assert.equal(signal.aborted, true)
  })

  await it('indexes only bounded, case-exact local CHD playlists without absorbing standalone rows', async (t) => {
    const invalid = {
      absolute: ['/media/Disc.chd', /relative, unescaped/u],
      backslash: [String.raw`Parts\Second.CHD`, /relative, unescaped/u],
      case: ['parts/Second.CHD', /exact filename, case/u],
      duplicate: ['First.chd', /duplicate disc/u],
      encoded: ['%252e%252e/Outside.chd', /relative, unescaped/u],
      missing: ['Missing.chd', /CHD not found/u],
      mixed: ['Second.cue', /only .chd/u],
      nested: ['Valid.m3u', /only .chd/u],
      otherSystem: ['../../psx/Outside.chd', /relative, unescaped/u],
      symlink: ['Link.chd', /links are not allowed/u],
      url: ['https://fixture.invalid/Second.chd', /relative, unescaped/u],
    } as const
    const f = await fixture(t, {
      'roms/nes/Not a PSX playlist.m3u': 'First.chd\nParts/Second.CHD\n',
      'roms/ps1/Campaign/Bad UTF-8.m3u': Uint8Array.of(0xff),
      'roms/ps1/Campaign/First.chd': 'independent disc one',
      'roms/ps1/Campaign/Large.m3u': '#'.padEnd(mountedPlaylistMaxBytes + 1, ' '),
      'roms/ps1/Campaign/One disc.m3u': 'First.chd\n',
      'roms/ps1/Campaign/Parts/Second.CHD': 'independent disc two',
      'roms/ps1/Campaign/Valid.m3u': '\uFEFF#EXTM3U\r\nParts/Second.CHD\r\n\r\n# Play order\r\nFirst.chd\n',
      'roms/psx/Outside.chd': 'different root',
      'roms/psx/Primary.m3u': 'Outside.chd\nSecond.chd\n',
      'roms/psx/Second.chd': 'second primary disc',
      ...Object.fromEntries(
        Object.entries(invalid).map(([name, [line]]) => [`roms/ps1/Campaign/${name}.m3u`, `First.chd\n${line}\n`]),
      ),
      ...Object.fromEntries(
        Array.from({ length: 9 }, (_, i) => [`roms/ps1/Campaign/Parts/Limited ${i}.chd`, `Disc ${i}`]),
      ),
      'roms/ps1/Campaign/Too many.m3u': Array.from({ length: 9 }, (_, i) => `Parts/Limited ${i}.chd`).join('\n'),
    })
    const [missing] = await f.library
      .select()
      .from(romTable)
      .where(eq(romTable.fileId, getMountedFileId('roms', 'ps1/Campaign/missing.m3u')))
    assert.ok(missing.mountedSource)
    await f.library
      .update(romTable)
      .set({ mountedSource: { ...missing.mountedSource, playlistIssue: undefined } })
      .where(eq(romTable.id, missing.id))
    await symlink(path.join(f.roms, 'psx/Outside.chd'), path.join(f.roms, 'ps1/Campaign/Link.chd'))
    const before = await sourceSnapshot(f.roms)
    const scanned = await f.mounted.scan()
    assert.equal(scanned.unsupported, Object.keys(invalid).length + 5)
    const { roms } = await f.list()
    const valid = roms.find(({ fileName }) => fileName === 'Campaign/Valid.m3u')
    assert.ok(valid?.mountedSource?.playlist)
    assert.deepEqual(
      valid.mountedSource.playlist.discs.map(({ path }) => path),
      ['ps1/Campaign/Parts/Second.CHD', 'ps1/Campaign/First.chd'],
    )
    assert.equal(roms.find(({ fileName }) => fileName === 'Primary.m3u')?.mountedSource?.playlist?.discs.length, 2)
    for (const [name, [, reason]] of Object.entries(invalid)) {
      const source = roms.find(({ fileName }) => fileName === `Campaign/${name}.m3u`)?.mountedSource
      assert.match(source?.unsupportedReason || '', reason, name)
      assert.equal(source?.playlist, undefined, name)
    }
    const missingDisc = roms.find(({ id }) => id === missing.id)?.mountedSource
    assert.deepEqual(missingDisc?.playlistIssue, { code: 'Missing', line: 2 })
    for (const [name, reason] of [
      ['Campaign/Bad UTF-8.m3u', /UTF-8/u],
      ['Campaign/Large.m3u', /64 KiB/u],
      ['Campaign/One disc.m3u', /at least two/u],
      ['Campaign/Too many.m3u', /at most 8/u],
      ['Not a PSX playlist.m3u', /not supported/u],
    ] as const) {
      const rom = roms.find(({ fileName }) => fileName === name)
      assert.ok(rom)
      assert.match(rom.mountedSource?.unsupportedReason || '', reason)
      await expectStatus(f.request(`/roms/${rom.id}/discs/1?revision=${valid.mountedSource.playlist.revision}`), 404)
    }
    const standalone = roms.find(({ fileName }) => fileName === 'Campaign/Parts/Second.CHD')
    assert.ok(standalone && !standalone.mountedSource?.unsupportedReason)
    const read = await expectStatus(f.request(`/files/${encodeURIComponent(standalone.fileId)}`), 200)
    assert.equal(await read.text(), 'independent disc two')
    assert.deepEqual(await sourceSnapshot(f.roms), before)
  })

  await it('streams only indexed playlist parts and revalidates visibility, dependencies and the descriptor', async (t) => {
    const second = 'second'.repeat(60_000)
    const f = await fixture(t, {
      'roms/psx/Series/First.chd': 'first',
      'roms/psx/Series/Second.chd': second,
      'roms/psx/Series/Series.m3u': 'First.chd\nSecond.chd\n',
    })
    const initial = await f.list()
    const game = initial.roms.find(({ fileName }) => fileName.endsWith('.m3u'))
    assert.ok(game?.mountedSource?.playlist)
    const original = game.mountedSource
    const gameId = game.id
    function url(index: number, revision = original.playlist?.revision) {
      return `/roms/${gameId}/discs/${index}?revision=${revision}`
    }
    await expectStatus(f.request(url(1), {}, ''), 400)
    await expectStatus(f.request(url(0)), 400)
    await expectStatus(f.request(url(3)), 404)
    await expectStatus(f.request(url(1, '../Outside.chd')), 400)
    const head = await expectStatus(f.request(url(2), { method: 'HEAD' }, 'bob'), 200)
    assert.equal(head.headers.get('Cache-Control'), 'private, no-store')
    assert.equal(head.headers.get('Content-Length'), String(second.length))
    assert.equal(await head.text(), '')
    const data = await expectStatus(f.request(`${url(1)}&path=Outside.chd`), 200)
    assert.equal(await data.text(), 'first')
    const abort = new AbortController()
    const streaming = await f.request(url(2), { signal: abort.signal })
    assert.equal(streaming.status, 200)
    assert.ok(streaming.body)
    const reader = streaming.body.getReader()
    const firstChunk = await reader.read()
    assert.equal(firstChunk.done, false)
    abort.abort()
    await assert.rejects(reader.read(), { name: 'AbortError' })

    await seedLegacyHiddenRom(f.library, game.id)
    await expectStatus(f.request(url(1), {}, 'bob'), 404)
    const restore = `/mounted-library/hidden/${game.id}/restore`
    await expectStatus(f.request(restore, { method: 'POST' }), 200)
    process.env.RETROASSEMBLY_RUN_TIME_ENABLE_SHARED_ROM_LIBRARY = 'false'
    await expectStatus(f.request(url(1)), 404)
    process.env.RETROASSEMBLY_RUN_TIME_ENABLE_SHARED_ROM_LIBRARY = 'true'

    const secondFile = path.join(f.roms, 'psx/Series/Second.chd')
    await rename(secondFile, `${secondFile}.old`)
    await symlink(path.join(f.roms, 'psx/Series/First.chd'), secondFile)
    await expectStatus(f.request(url(2)), 503)
    await rm(secondFile)
    await writeFile(secondFile, 'replacement')
    await expectStatus(f.request(url(2), { method: 'HEAD' }), 409)

    const incomplete = path.join(f.roms, 'psx/zzz')
    await mkdir(incomplete)
    const readDirectory = fs.readdir
    const interruptedTraversal = t.mock.method(
      fs,
      'readdir',
      async function read(...args: Parameters<typeof readDirectory>) {
        if (args[0] === incomplete) {
          throw new Error('Fixture traversal interrupted')
        }
        return await readDirectory(...args)
      },
    )
    syncBuiltinESMExports()
    try {
      await assert.rejects(f.mounted.scan(), /Fixture traversal interrupted/u)
      const afterFailure = await f.list()
      assert.deepEqual(afterFailure.roms.find(({ id }) => id === game.id)?.mountedSource?.playlist, original.playlist)
      await expectStatus(f.request(url(2)), 409)
    } finally {
      interruptedTraversal.mock.restore()
      syncBuiltinESMExports()
      await rmdir(incomplete)
    }

    await f.mounted.scan()
    const afterScan = await f.list()
    const refreshed = afterScan.roms.find(({ id }) => id === game.id)?.mountedSource
    assert.ok(refreshed?.playlist)
    assert.equal(refreshed.revision, original.revision)
    assert.notEqual(refreshed.playlist.revision, original.playlist?.revision)
    await expectStatus(f.request(url(1)), 409)
    const updated = await expectStatus(f.request(url(2, refreshed.playlist.revision)), 200)
    assert.equal(await updated.text(), 'replacement')

    await writeFile(path.join(f.roms, original.path), 'Second.chd\nFirst.chd\n')
    await expectStatus(f.request(url(1, refreshed.playlist.revision)), 409)
    await rm(path.join(f.roms, original.path))
    await expectStatus(f.request(url(1, refreshed.playlist.revision)), 503)
    await f.mounted.scan()
    await expectStatus(f.request(url(1, refreshed.playlist.revision)), 404)
  })

  await it('keeps playlist saves private and resumes only on their indexed revision and disc', async (t) => {
    const f = await fixture(t, {
      'roms/psx/First.chd': 'first',
      'roms/psx/Second.chd': 'second',
      'roms/psx/Test.m3u': 'First.chd\nSecond.chd\n',
    })
    const { roms } = await f.list()
    const game = roms.find(({ fileName }) => fileName === 'Test.m3u')
    const standalone = roms.find(({ fileName }) => fileName === 'Second.chd')
    assert.ok(game?.mountedSource?.playlist && standalone)
    const { revision } = game.mountedSource.playlist
    await expectStatus(f.request('/states', playlistSaveForm(game.id, 'manual')), 409)
    await expectStatus(f.request('/states', playlistSaveForm(game.id, 'manual', { disc: '3', revision })), 409)
    await expectStatus(f.request('/states', playlistSaveForm(standalone.id, 'manual', { disc: '2', revision })), 409)
    const single = await expectStatus(f.request('/states', playlistSaveForm(standalone.id, 'manual')), 200)
    assert.equal(z.object({ playlist: z.null() }).parse(await single.json()).playlist, null)
    for (const type of ['manual', 'auto'] as const) {
      const result = await expectStatus(
        f.request('/states', playlistSaveForm(game.id, type, { disc: '2', revision })),
        200,
      )
      const saved = z.object({ fileId: z.string(), playlist: playlistBinding }).parse(await result.json())
      assert.deepEqual(saved.playlist, { disc: 2, revision })
      await expectStatus(f.request(`/files/${encodeURIComponent(saved.fileId)}`, {}, 'bob'), 404)
    }
    const playback = await f.playback(game.id)
    const otherPlayback = await f.playback(game.id, 'bob')
    assert.deepEqual(playback.state?.playlist, { disc: 2, revision })
    assert.equal(otherPlayback.state, undefined)
    const patch = new FormData()
    patch.set('gameName', 'Manual playlist title')
    await expectStatus(f.request(`/roms/${game.id}`, { body: patch, method: 'PATCH' }), 200)
    await writeFile(path.join(f.roms, 'psx/Test.m3u'), 'Second.chd\nFirst.chd\n')
    await expectStatus(f.request('/states', playlistSaveForm(game.id, 'auto', { disc: '2', revision })), 409)
    await f.mounted.scan()
    await expectStatus(f.request('/states', playlistSaveForm(game.id, 'manual', { disc: '2', revision })), 409)
    const stale = await f.playback(game.id)
    const rescanned = await f.list()
    assert.equal(stale.state, undefined)
    assert.equal(rescanned.roms.find(({ id }) => id === game.id)?.gameName, 'Manual playlist title')
    const owner = await expectStatus(f.request(`/states?rom=${game.id}&type=manual`), 200)
    assert.deepEqual(z.array(z.object({ playlist: playlistBinding })).parse(await owner.json()), [
      { playlist: { disc: 2, revision } },
    ])
    const standalonePlayback = await f.playback(standalone.id)
    assert.equal(standalonePlayback.state?.playlist, null)
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
