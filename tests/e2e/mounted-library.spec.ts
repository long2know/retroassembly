import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { expect, test } from '@playwright/test'

interface Rom {
  fileId: string
  fileName: string
  gameBoxartFileIds: null | string
  gameName: null | string
  id: string
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

test('mounted sources remain immutable through browser play, state saving, rescans and two restarts', async ({
  page,
}) => {
  const container = process.env.RETROASSEMBLY_MOUNTED_TEST_CONTAINER
  test.skip(!container, 'Run mounted-library-docker.ts against a locally built production image')
  if (!container?.startsWith('retro-web-5c9839ba-app-')) {
    throw new Error('Refusing to restart an unrecognized acceptance container')
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
    .toBe(1)
  const firstScan = await page.request.post('/api/v1/mounted-library')
  expect(firstScan.status()).toBe(200)
  const firstStatus = await page.request.get('/api/v1/mounted-library')
  expect(await firstStatus.json()).toMatchObject({ indexed: 1 })

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
    const persistedRom = await findRom()
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
  await fs.writeFile(
    process.env.RETROASSEMBLY_MOUNTED_TEST_BROWSER_REPORT || '',
    JSON.stringify({
      biosPlatforms,
      canvasFrames: [firstFrame, changedFrame],
      coreRequests,
      cover: { fileId: coverFileId, sha256: hash(coverBytes) },
      crossOriginIsolated: await page.evaluate(() => crossOriginIsolated),
      restarts: 2,
      resumedCanvasFrames: [resumedFrame, resumedChangedFrame],
      romId: rom.id,
      sourceRequests,
      state: { fileId: state.fileId, sha256: hash(stateBytes) },
      wasmInstances: await page.evaluate(() => Number(Reflect.get(globalThis, 'mountedLibraryWasmInstances'))),
    }),
  )
})
