import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { MountedLibraryStatus, MountedSource } from '../../src/constants/mounted-library.ts'

interface Rom {
  fileId: string
  fileName: string
  gameBoxartFileIds: null | string
  gameName: null | string
  id: string
  mountedSource: MountedSource
  platform: string
  userId: null | string
}

interface State {
  fileId: string
  id: string
  romId: string
  userId: string
}

interface Bios {
  fileId: string
  fileName: string
}

function hash(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

function inspectAppFile(container: string, fileId: string) {
  return JSON.parse(
    execFileSync(
      'docker',
      [
        'exec',
        container,
        'node',
        '-e',
        `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
    const root='/app/data/storage/',file=path.resolve(root,process.argv[1]);
    if(!file.startsWith(root))throw new Error('File escaped app storage');
    const bytes=fs.readFileSync(file),stat=fs.statSync(file);
    console.log(JSON.stringify({sha256:crypto.createHash('sha256').update(bytes).digest('hex'),uid:stat.uid}));`,
        fileId,
      ],
      { encoding: 'utf8' },
    ),
  )
}

function providerMatches(providerContainer: string) {
  const logs = execFileSync('docker', ['logs', providerContainer], { encoding: 'utf8' }).trim()
  const records: { matched: boolean; method: string }[] = logs
    ? logs.split('\n').map(function parseRecord(line) {
        return JSON.parse(line)
      })
    : []
  return records.filter(function matched(record) {
    return record.method === 'POST' && record.matched
  }).length
}

test('mounted sources remain immutable through content matching, settings, browser play and two restarts', async ({
  page,
}) => {
  const container = process.env.RETROASSEMBLY_MOUNTED_TEST_CONTAINER
  test.skip(!container, 'Run mounted-library-docker.ts against a locally built production image')
  if (!container?.startsWith('retro-web-5c9839ba-app-')) {
    throw new Error('Refusing to restart an unrecognized acceptance container')
  }
  const provider = process.env.RETROASSEMBLY_MOUNTED_TEST_PROVIDER
  if (!provider?.startsWith('retro-web-5c9839ba-provider-')) {
    throw new Error('Refusing to inspect an unrecognized acceptance provider')
  }
  let preferenceWrites = 0
  page.on('request', function recordPreferenceWrite(request) {
    if (new URL(request.url()).pathname === '/api/v1/preference' && request.method() === 'POST') {
      preferenceWrites += 1
    }
  })

  async function mountedStatus() {
    const response = await page.request.get('/api/v1/mounted-library')
    expect(response.status(), await response.text()).toBe(200)
    const status: MountedLibraryStatus = await response.json()
    return status
  }

  async function metadataIdle() {
    await expect
      .poll(
        async function metadataFinished() {
          const status = await mountedStatus()
          return status.metadata.running
        },
        { timeout: 60_000 },
      )
      .toBe(false)
  }

  async function openSettings() {
    await page.getByRole('button', { exact: true, name: 'Menu' }).click()
    await page.getByRole('menuitem', { exact: true, name: 'Settings' }).click()
    return page.getByRole('dialog', { exact: true, name: 'Settings' })
  }

  const coreRequests: { status: number; url: string }[] = []
  const sourceRequests: { status: number; url: string }[] = []
  page.on('response', function recordCore(response) {
    if (response.url().includes('_libretro.zip')) {
      coreRequests.push({ status: response.status(), url: response.url() })
    }
    if (response.url().includes('/api/v1/files/')) {
      sourceRequests.push({ status: response.status(), url: response.url() })
    }
  })
  await page.addInitScript(function recordWasm() {
    Reflect.set(globalThis, 'mountedLibraryWasmInstances', 0)
    for (const name of ['instantiate', 'instantiateStreaming'] as const) {
      const original = WebAssembly[name]
      Object.defineProperty(WebAssembly, name, {
        async value(...args: Parameters<typeof WebAssembly.instantiate>) {
          const result = await Reflect.apply(original, WebAssembly, args)
          Reflect.set(
            globalThis,
            'mountedLibraryWasmInstances',
            Number(Reflect.get(globalThis, 'mountedLibraryWasmInstances')) + 1,
          )
          return result
        },
      })
    }
  })

  const registration = await page.request.post('/api/v1/auth/register', {
    form: { password: `fixture-only-${randomUUID()}`, username: `mounted-${randomUUID().slice(0, 8)}` },
  })
  expect(registration.status(), await registration.text()).toBe(200)
  const account: { user: { id: string } } = await registration.json()
  await expect
    .poll(
      async function startupIndex() {
        const response = await page.request.get('/api/v1/mounted-library')
        if (!response.ok()) {
          return 0
        }
        const status: { indexed: number } = await response.json()
        return status.indexed
      },
      { timeout: 30_000 },
    )
    .toBe(2)
  const firstScan = await page.request.post('/api/v1/mounted-library')
  expect(firstScan.status()).toBe(200)
  const firstStatus = await page.request.get('/api/v1/mounted-library')
  expect(await firstStatus.json()).toMatchObject({ indexed: 2 })

  async function findRom() {
    const response = await page.request.get('/api/v1/roms/search?query=Immutable%20Pulse')
    expect(response.status(), await response.text()).toBe(200)
    const result: { roms: Rom[] } = await response.json()
    const games = result.roms.filter((rom) => rom.fileName === 'Homebrew/Immutable Pulse.nes')
    expect(games).toHaveLength(1)
    return games[0]
  }

  const rom = await findRom()
  expect(rom.platform).toBe('nes')
  expect(rom.userId).toBeNull()
  await expect
    .poll(
      async function providerEnrichment() {
        const found = await findRom()
        return found.gameName
      },
      { timeout: 60_000 },
    )
    .toBe('Immutable Pulse — provider metadata')
  for (const url of [`/api/v1/files/${encodeURIComponent(rom.fileId)}`, `/api/v1/roms/${rom.id}/content`]) {
    const response = await page.request.get(url)
    expect(response.status(), await response.text()).toBe(200)
    expect(hash(await response.body())).toBe(process.env.RETROASSEMBLY_MOUNTED_TEST_ROM_SHA256)
  }

  async function findArchive() {
    const response = await page.request.get('/api/v1/roms/search?query=GoodTools%20Alias')
    expect(response.status(), await response.text()).toBe(200)
    const result: { roms: Rom[] } = await response.json()
    const games = result.roms.filter(function archive(candidate) {
      return candidate.fileName === 'Homebrew/GoodTools Alias (U) [!].zip'
    })
    expect(games).toHaveLength(1)
    return games[0]
  }

  async function identificationCache() {
    const rawRom = await findRom()
    const zipRom = await findArchive()
    return { raw: rawRom.mountedSource.identification, zip: zipRom.mountedSource.identification }
  }

  await expect
    .poll(
      async function archiveEnrichment() {
        const foundArchive = await findArchive()
        return foundArchive.gameName
      },
      { timeout: 60_000 },
    )
    .toBe('Archive Pulse — content metadata')
  await metadataIdle()
  const archive = await findArchive()
  expect(archive.mountedSource).toMatchObject({ metadata: 'ready', metadataOutcome: 'matched' })
  expect(archive.mountedSource.identification).toMatchObject({
    confidence: 'content',
    md5: process.env.RETROASSEMBLY_MOUNTED_TEST_ZIP_CONTENT_MD5,
    mode: 'zip-entry',
    payloadName: 'Inner Payload.nes',
  })
  expect(typeof archive.mountedSource.identification?.hashedAt).toBe('number')
  const matchedRom = await findRom()
  expect(matchedRom.mountedSource.identification).toMatchObject({ confidence: 'content', mode: 'file' })
  for (const url of [`/api/v1/files/${encodeURIComponent(archive.fileId)}`, `/api/v1/roms/${archive.id}/content`]) {
    const response = await page.request.get(url)
    expect(response.status(), await response.text()).toBe(200)
    expect(hash(await response.body())).toBe(process.env.RETROASSEMBLY_MOUNTED_TEST_ZIP_SHA256)
  }

  const preferenceResponse = await page.request.get('/api/v1/preference')
  expect(preferenceResponse.status()).toBe(200)
  const preference: { emulator: { platform: Record<string, { bioses: Bios[] }> } } = await preferenceResponse.json()
  const biosPlatforms: string[] = []
  let mountedBios: Bios | undefined
  for (const [platform, options] of Object.entries(preference.emulator.platform)) {
    const bios = options.bioses.find((candidate) => candidate.fileName === 'nes.pal')
    if (bios) {
      biosPlatforms.push(platform)
      mountedBios = bios
    }
  }
  expect(biosPlatforms).toContain('famicom')
  if (!mountedBios) {
    throw new Error('Mounted synthetic BIOS/palette fixture was not selected')
  }
  const biosResponse = await page.request.get(`/api/v1/files/${encodeURIComponent(mountedBios.fileId)}`)
  expect(biosResponse.status()).toBe(200)
  expect(hash(await biosResponse.body())).toBe(process.env.RETROASSEMBLY_MOUNTED_TEST_BIOS_SHA256)

  for (const invalid of [
    `${rom.fileId}/../../data/retroassembly.sqlite`,
    `${mountedBios.fileId}/../nes.pal`,
    '../retroassembly.sqlite',
  ]) {
    const response = await page.request.get(`/api/v1/files/${encodeURIComponent(invalid)}`)
    expect([400, 403, 404]).toContain(response.status())
  }

  const override = 'Immutable Pulse — app-owned metadata'
  const update = await page.request.patch(`/api/v1/roms/${rom.id}`, {
    form: { gameDescription: 'Original synthetic homebrew fixture', gameName: override },
  })
  expect(update.status(), await update.text()).toBe(200)
  const updatedRom = await findRom()
  expect(updatedRom.gameName).toBe(override)

  await page.goto('/library/roms')
  await page.getByText(override, { exact: true }).first().click()
  await page.getByText(/^start$/iu).click()
  const canvas = page.locator('#canvas')
  await expect(canvas).toBeVisible({ timeout: 90_000 })
  await expect(canvas).toHaveCSS('opacity', '1', { timeout: 90_000 })
  await expect
    .poll(async function wasmInstances() {
      return await page.evaluate(() => Number(Reflect.get(globalThis, 'mountedLibraryWasmInstances')))
    })
    .toBeGreaterThan(0)
  const firstFrame = hash(await canvas.screenshot())
  let changedFrame = firstFrame
  await expect
    .poll(
      async function emulatedFrames() {
        changedFrame = hash(await canvas.screenshot())
        return changedFrame
      },
      { timeout: 15_000 },
    )
    .not.toBe(firstFrame)
  expect(coreRequests.some((request) => request.status === 200)).toBe(true)
  for (const fileId of [rom.fileId, mountedBios.fileId]) {
    expect(
      sourceRequests.some(
        (request) =>
          request.status === 200 && new URL(request.url).pathname === `/api/v1/files/${encodeURIComponent(fileId)}`,
      ),
    ).toBe(true)
  }
  const coverBytes = await canvas.screenshot()
  const coverResponse = await page.request.post(`/api/v1/roms/${rom.id}/boxart`, {
    multipart: { file: { buffer: coverBytes, mimeType: 'image/png', name: 'original-fixture-cover.png' } },
  })
  expect(coverResponse.status(), await coverResponse.text()).toBe(200)
  const coverFileId: string = await coverResponse.json()
  expect(inspectAppFile(container, coverFileId)).toEqual({ sha256: hash(coverBytes), uid: 1000 })

  await page.keyboard.press('Escape')
  const savedResponse = page.waitForResponse(function saved(response) {
    return response.url().endsWith('/api/v1/states') && response.request().method() === 'POST'
  })
  await page.getByText(/^save state$/iu).click()
  const saved = await savedResponse
  expect(saved.ok(), await saved.text()).toBe(true)
  const state: State = await saved.json()
  expect(state.romId).toBe(rom.id)
  expect(state.userId).toBe(account.user.id)
  const stateResponse = await page.request.get(`/api/v1/files/${encodeURIComponent(state.fileId)}`)
  expect(stateResponse.status()).toBe(200)
  const stateBytes = await stateResponse.body()
  expect(stateBytes.byteLength).toBeGreaterThan(100)
  const storedState = inspectAppFile(container, state.fileId)
  expect(storedState.sha256).toBe(hash(stateBytes))
  expect(storedState.uid).toBe(1000)
  await page.getByText(/^save & exit$/iu).click()
  await expect(canvas).not.toBeAttached()

  const initialIdentification = await identificationCache()
  const rawIdentification = initialIdentification.raw
  const archiveIdentification = initialIdentification.zip
  const beforeNavigation = await mountedStatus()
  const beforeNavigationMatches = providerMatches(provider)
  const disableNes = await page.request.post('/api/v1/preference', { data: { ui: { platforms: ['snes'] } } })
  expect(disableNes.status(), await disableNes.text()).toBe(200)
  await page.goto('/library/roms')
  const settings = await openSettings()
  await settings.getByRole('tab', { exact: true, name: 'Library' }).click()
  const beforeSettingsWrites = preferenceWrites
  await expect(settings.getByTestId('platform-count-nes')).toHaveText('Indexed: 2')
  await expect(settings.getByRole('checkbox', { exact: true, name: 'NES' })).not.toBeChecked()
  const hideEmpty = settings.getByRole('checkbox', { exact: true, name: 'Hide empty platforms' })
  await hideEmpty.check()
  await expect(settings.getByTestId('platform-option-snes')).not.toBeVisible()
  await expect(settings.getByTestId('platform-option-nes')).toBeVisible()
  await hideEmpty.uncheck()
  await expect(settings.getByTestId('platform-option-snes')).toBeVisible()
  const unchangedPreferences = await page.request.get('/api/v1/preference')
  expect(await unchangedPreferences.json()).toMatchObject({ ui: { platforms: ['snes'] } })
  expect(preferenceWrites).toBe(beforeSettingsWrites)
  const enableResponse = page.waitForResponse(function enabled(response) {
    return new URL(response.url()).pathname === '/api/v1/preference' && response.request().method() === 'POST'
  })
  await settings.getByRole('button', { exact: true, name: 'Enable platforms with ROMs' }).click()
  const enabled = await enableResponse
  expect(enabled.status()).toBe(200)
  await expect(settings.getByRole('checkbox', { exact: true, name: 'NES' })).toBeChecked()
  const enabledPreferences = await page.request.get('/api/v1/preference')
  expect(await enabledPreferences.json()).toMatchObject({ ui: { platforms: ['nes'] } })
  const counts = await mountedStatus()
  expect(
    counts.platforms.find(function nes(platform) {
      return platform.platform === 'nes'
    }),
  ).toEqual({
    indexed: 2,
    platform: 'nes',
    unsupported: 0,
  })
  await settings.getByRole('tab', { exact: true, name: 'ROM / Metadata' }).click()
  await expect(settings.getByTestId('mounted-library-status')).toBeVisible()
  const scanInterval = settings.getByRole('spinbutton', { exact: true, name: 'Scan interval (seconds)' })
  for (const seconds of ['3600', '0']) {
    await scanInterval.fill(seconds)
    const intervalResponse = page.waitForResponse(function intervalSaved(response) {
      return new URL(response.url()).pathname === '/api/v1/mounted-library' && response.request().method() === 'PATCH'
    })
    await settings.getByRole('button', { exact: true, name: 'Save scan interval' }).click()
    const savedInterval = await intervalResponse
    expect(savedInterval.status()).toBe(200)
    const intervalStatus = await mountedStatus()
    expect(intervalStatus.settings.scanIntervalSeconds).toBe(Number(seconds))
  }
  const automatic = settings.getByRole('switch', { exact: true, name: 'Automatic metadata and cover downloads' })
  await expect(automatic).toBeChecked()
  const automaticResponse = page.waitForResponse(function automaticSaved(response) {
    return new URL(response.url()).pathname === '/api/v1/mounted-library' && response.request().method() === 'PATCH'
  })
  await automatic.click()
  const savedAutomatic = await automaticResponse
  expect(savedAutomatic.status()).toBe(200)
  await expect(automatic).not.toBeChecked()
  expect(await mountedStatus()).toMatchObject({
    automaticMetadataEnabled: false,
    networkAllowed: true,
    settings: { automaticMetadata: false, scanIntervalSeconds: 0 },
  })
  const reportDirectory = path.dirname(
    process.env.RETROASSEMBLY_MOUNTED_TEST_REPORT || 'node_modules/.cache/ci/built-image.json',
  )
  await fs.mkdir(reportDirectory, { recursive: true })
  await page.screenshot({ path: path.join(reportDirectory, 'mounted-metadata-settings.png') })
  const automaticCoverRequests: string[] = []
  const cachedPage = await page.context().newPage()
  await cachedPage.route(
    /https:\/\/(?:thumbnails\.libretro\.com\/|cdn\.jsdelivr\.net\/gh\/libretro-thumbnails\/)/u,
    async function blockRemoteCover(route) {
      automaticCoverRequests.push(route.request().url())
      await route.abort()
    },
  )
  await cachedPage.goto('/library/roms')
  await cachedPage.getByText('Archive Pulse — content metadata', { exact: true }).first().click()
  await cachedPage.goto('/library/roms')
  const cachedCover = cachedPage.locator(`img[src="/api/v1/files/${encodeURIComponent(coverFileId)}"]`).first()
  await expect(cachedCover).toBeVisible()
  await expect
    .poll(async function renderedCachedCover() {
      return await cachedCover.evaluate(function loaded(image) {
        return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
      })
    })
    .toBe(true)
  await cachedPage.close()
  expect(automaticCoverRequests).toEqual([])
  expect(providerMatches(provider)).toBe(beforeNavigationMatches)
  const afterNavigation = await mountedStatus()
  expect(afterNavigation.lastScanStartedAt).toBe(beforeNavigation.lastScanStartedAt)
  expect(afterNavigation.lastScanFinishedAt).toBe(beforeNavigation.lastScanFinishedAt)
  expect(await identificationCache()).toEqual(initialIdentification)

  const refreshResponse = page.waitForResponse(function refreshed(response) {
    return (
      new URL(response.url()).pathname === '/api/v1/mounted-library/metadata' && response.request().method() === 'POST'
    )
  })
  await settings.getByRole('button', { exact: true, name: 'Refresh metadata' }).click()
  const refreshed = await refreshResponse
  expect(refreshed.status()).toBe(200)
  await metadataIdle()
  expect(providerMatches(provider)).toBeGreaterThan(beforeNavigationMatches)
  const metadataStatus = await mountedStatus()
  expect(metadataStatus.metadata.operation).toBe('metadata')
  expect(await identificationCache()).toEqual(initialIdentification)
  const retryResponse = page.waitForResponse(function retried(response) {
    return (
      new URL(response.url()).pathname === '/api/v1/mounted-library/artwork' && response.request().method() === 'POST'
    )
  })
  await settings.getByRole('button', { exact: true, name: 'Retry missing covers' }).click()
  const retriedArtwork = await retryResponse
  expect(retriedArtwork.status()).toBe(200)
  await metadataIdle()
  const artworkStatus = await mountedStatus()
  expect(artworkStatus.metadata.operation).toBe('artwork')
  const beforeExplicitScanMatches = providerMatches(provider)
  const scanResponse = page.waitForResponse(function scanned(response) {
    return new URL(response.url()).pathname === '/api/v1/mounted-library' && response.request().method() === 'POST'
  })
  await settings.getByRole('button', { exact: true, name: 'Scan ROM folders' }).click()
  const scanned = await scanResponse
  expect(scanned.status()).toBe(200)
  await expect
    .poll(async function scanFinished() {
      const status = await mountedStatus()
      return status.running
    })
    .toBe(false)
  await metadataIdle()
  expect(providerMatches(provider)).toBe(beforeExplicitScanMatches)
  const scanStatus = await mountedStatus()
  expect(scanStatus.indexed).toBe(2)
  expect(await identificationCache()).toEqual(initialIdentification)
  expect(await findRom()).toMatchObject({
    gameBoxartFileIds: coverFileId,
    gameName: override,
    id: rom.id,
    mountedSource: { metadata: 'manual' },
  })
  await settings.getByTitle('Close', { exact: true }).click()
  await page.goto('/library/roms')
  await page.getByText(override, { exact: true }).first().click()
  const beforeRestartMatches = providerMatches(provider)

  for (let restart = 0; restart < 2; restart += 1) {
    execFileSync('docker', ['restart', container], { encoding: 'utf8' })
    await expect
      .poll(
        async function restarted() {
          try {
            const status = await page.request.get('/api/v1/mounted-library')
            return status.status()
          } catch {
            return 0
          }
        },
        { timeout: 30_000 },
      )
      .toBe(200)
    const rescan = await page.request.post('/api/v1/mounted-library')
    expect(rescan.status()).toBe(200)
    expect(await mountedStatus()).toMatchObject({
      automaticMetadataEnabled: false,
      settings: { automaticMetadata: false, scanIntervalSeconds: 0 },
    })
    const persistedArchive = await findArchive()
    expect(persistedArchive.id).toBe(archive.id)
    expect(persistedArchive.mountedSource.identification).toEqual(archiveIdentification)
    expect(providerMatches(provider)).toBe(beforeRestartMatches)
    const persistedRom = await findRom()
    expect(persistedRom.mountedSource.identification).toEqual(rawIdentification)
    expect(persistedRom.id).toBe(rom.id)
    expect(persistedRom.gameName).toBe(override)
    expect(persistedRom.gameBoxartFileIds).toBe(coverFileId)
    const persistedCover = await page.request.get(`/api/v1/files/${encodeURIComponent(coverFileId)}`)
    expect(persistedCover.status()).toBe(200)
    expect(hash(await persistedCover.body())).toBe(hash(coverBytes))
    const statesResponse = await page.request.get(`/api/v1/roms/${rom.id}/states?type=manual`)
    expect(statesResponse.status()).toBe(200)
    const states: State[] = await statesResponse.json()
    expect(states.some((candidate) => candidate.id === state.id)).toBe(true)
    const persistedState = await page.request.get(`/api/v1/files/${encodeURIComponent(state.fileId)}`)
    expect(persistedState.status()).toBe(200)
    expect(hash(await persistedState.body())).toBe(hash(stateBytes))
  }
  await page.reload()
  const restartedSettings = await openSettings()
  await restartedSettings.getByRole('tab', { exact: true, name: 'ROM / Metadata' }).click()
  await expect(
    restartedSettings.getByRole('switch', { exact: true, name: 'Automatic metadata and cover downloads' }),
  ).not.toBeChecked()
  await expect(restartedSettings.getByRole('spinbutton', { exact: true, name: 'Scan interval (seconds)' })).toHaveValue(
    '0',
  )
  await restartedSettings.getByTitle('Close', { exact: true }).click()
  await page.getByText(/^continue$/iu).click()
  await expect(canvas).toBeVisible({ timeout: 90_000 })
  await expect(canvas).toHaveCSS('opacity', '1', { timeout: 90_000 })
  await expect
    .poll(async function resumedWasm() {
      return await page.evaluate(() => Number(Reflect.get(globalThis, 'mountedLibraryWasmInstances')))
    })
    .toBeGreaterThan(0)
  const resumedFrame = hash(await canvas.screenshot())
  let resumedChangedFrame = resumedFrame
  await expect
    .poll(
      async function resumedExecution() {
        resumedChangedFrame = hash(await canvas.screenshot())
        return resumedChangedFrame
      },
      { timeout: 15_000 },
    )
    .not.toBe(resumedFrame)
  const finalStatus = await mountedStatus()
  await fs.writeFile(
    process.env.RETROASSEMBLY_MOUNTED_TEST_BROWSER_REPORT || '',
    JSON.stringify({
      automaticCoverRequests,
      automaticMetadata: finalStatus.settings.automaticMetadata,
      biosPlatforms,
      canvasFrames: [firstFrame, changedFrame],
      coreRequests,
      cover: { fileId: coverFileId, sha256: hash(coverBytes) },
      crossOriginIsolated: await page.evaluate(() => crossOriginIsolated),
      platformCounts: counts.platforms,
      providerMatches: providerMatches(provider),
      restarts: 2,
      resumedCanvasFrames: [resumedFrame, resumedChangedFrame],
      romId: rom.id,
      sourceRequests,
      state: { fileId: state.fileId, sha256: hash(stateBytes) },
      wasmInstances: await page.evaluate(() => Number(Reflect.get(globalThis, 'mountedLibraryWasmInstances'))),
      zip: { identification: archiveIdentification, romId: archive.id },
    }),
  )
})
