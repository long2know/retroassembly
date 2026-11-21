import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createSyntheticBatteryNesRom, syntheticBatteryRomName } from './fixtures/synthetic-nes.ts'

type Color = 'red' | 'green' | 'blue'
interface Game {
  fileName: string
  id: string
  platform: string
}

const pinnedFceumm =
  'https://cdn.jsdelivr.net/gh/arianrhodsandlot/retroarch-emscripten-build@v1.22.2-1/retroarch/fceumm_libretro.zip'

function newAccount() {
  return { password: `fixture-only-${randomUUID()}`, username: `battery-${randomUUID().slice(0, 8)}` }
}

function overlay(page: Page) {
  return page.locator('.game-overlay')
}

function syncButton(page: Page) {
  return overlay(page).getByRole('button', { exact: true, name: 'Sync in-game save' })
}

async function expectColor(page: Page, wanted: Color) {
  const canvas = page.locator('#canvas')
  await expect(canvas).toHaveCSS('opacity', '1', { timeout: 90_000 })
  await expect
    .poll(
      async () => {
        const bounds = await canvas.boundingBox()
        if (!bounds) {
          return 'none'
        }
        const png = await page.screenshot({
          clip: {
            height: 1,
            width: 1,
            x: Math.floor(bounds.x + bounds.width / 2),
            y: Math.floor(bounds.y + bounds.height / 2),
          },
        })
        return await page.evaluate(async (data) => {
          const response = await fetch(`data:image/png;base64,${data}`)
          const image = await createImageBitmap(await response.blob())
          const context = new OffscreenCanvas(1, 1).getContext('2d')
          if (!context) {
            return 'none'
          }
          context.drawImage(image, 0, 0)
          image.close()
          const [red, green, blue] = context.getImageData(0, 0, 1, 1).data
          if (red > Math.max(green, blue) * 1.5) {
            return 'red'
          }
          if (green > Math.max(red, blue) * 1.5) {
            return 'green'
          }
          return blue > Math.max(red, green) * 1.5 ? 'blue' : `${red},${green},${blue}`
        }, png.toString('base64'))
      },
      { timeout: 15_000 },
    )
    .toBe(wanted)
}

async function controllerButton(page: Page, key: 'x' | 'z', wanted: Color) {
  await page.bringToFront()
  await page.keyboard.down(key)
  try {
    await expectColor(page, wanted)
  } finally {
    await page.keyboard.up(key)
  }
}

async function pause(page: Page) {
  await page.keyboard.press('Escape')
  await expect(overlay(page).getByRole('button', { exact: true, name: 'Resume' })).toBeVisible()
}

async function start(page: Page, wanted: Color, name: 'start' | 'continue' = 'start') {
  await page.bringToFront()
  const button = page.getByRole('button', { name: name === 'start' ? /^Start$/u : /^Continue\b/u })
  await expect(button).toBeEnabled({ timeout: 90_000 })
  await button.click()
  await expectColor(page, wanted)
}

async function exit(page: Page, name: 'Exit' | 'Save & Exit' = 'Exit') {
  await overlay(page).getByRole('button', { exact: true, name }).click()
  await expect(page.locator('#canvas')).not.toBeAttached()
}

async function recordInstantiatedWasm(page: Page) {
  await page.addInitScript(() => {
    const hashes: string[] = []
    Object.defineProperty(globalThis, 'fixtureWasmHashes', { value: hashes })
    WebAssembly.instantiate = new Proxy(WebAssembly.instantiate, {
      async apply(target, thisArgument, args) {
        const input: unknown = args[0]
        if (input instanceof ArrayBuffer || input instanceof Uint8Array) {
          const bytes = input instanceof ArrayBuffer ? input : Uint8Array.from(input).buffer
          const digest = await crypto.subtle.digest('SHA-256', bytes)
          hashes.push(new Uint8Array(digest).toHex())
        }
        return await Reflect.apply(target, thisArgument, args)
      },
    })
  })
}

test('syncs actual battery RAM privately and keeps NES snapshots separate', async ({ browser, page }) => {
  const deployment = process.env.RETROASSEMBLY_MOUNTED_TEST_URL
  test.skip(!deployment, 'Requires isolated production acceptance')
  const basePath = new URL(deployment || '').pathname.replace(/\/$/u, '')
  const upload = process.env.RETROASSEMBLY_IN_GAME_SAVE_TEST_UPLOAD === 'true'
  function appPath(pathname: string) {
    return `${basePath}${pathname}`
  }
  function gamePath({ fileName, id, platform }: Game) {
    return appPath(`/library/platform/${platform}/rom/${encodeURIComponent(fileName)}?rom_id=${id}`)
  }
  async function auth(
    target: Page,
    credentials: { password: string; username: string },
    action: 'login' | 'register' = 'register',
  ) {
    const response = await target.request.post(appPath(`/api/v1/auth/${action}`), { form: credentials })
    expect(response.ok(), await response.text()).toBe(true)
  }
  async function findGame(target: Page) {
    if (upload) {
      const response = await target.request.post(appPath('/api/v1/roms'), {
        multipart: {
          file: {
            buffer: createSyntheticBatteryNesRom(),
            mimeType: 'application/octet-stream',
            name: syntheticBatteryRomName,
          },
          platform: 'famicom',
        },
      })
      expect(response.ok(), await response.text()).toBe(true)
      const game: Game = await response.json()
      expect(game.platform).toBe('famicom')
      return game
    }
    const query = new URLSearchParams({ query: path.parse(syntheticBatteryRomName).name })
    const response = await target.request.get(appPath(`/api/v1/roms/search?${query}`))
    expect(response.ok(), await response.text()).toBe(true)
    const { roms }: { roms: Game[] } = await response.json()
    const game = roms.find(({ fileName }) => fileName === `Homebrew/${syntheticBatteryRomName}`)
    if (!game) {
      throw new Error('Mounted acceptance needs the original synthetic battery cartridge')
    }
    expect(game.platform).toBe('nes')
    return game
  }
  const account = newAccount()
  await auth(page, account)
  const game = await findGame(page)
  const detail = gamePath(game)
  const savePath = appPath(`/api/v1/roms/${game.id}/in-game-save`)
  const staleContext = await browser.newContext({ baseURL: deployment })
  const freshContext = await browser.newContext({ baseURL: deployment })
  const otherContext = await browser.newContext({ baseURL: deployment })
  try {
    const [stale, fresh, other] = await Promise.all([
      staleContext.newPage(),
      freshContext.newPage(),
      otherContext.newPage(),
    ])
    await recordInstantiatedWasm(page)
    const coreResponse = page.waitForResponse(pinnedFceumm)
    await page.goto(detail)
    await start(page, 'red')
    const coreZip = await coreResponse
    expect(coreZip.ok()).toBe(true)
    const hashes = await page.evaluate(() => Reflect.get(globalThis, 'fixtureWasmHashes'))
    expect(hashes).toContain('f035f172f9bf9a2ed9a8fd59708a9ae2bd3f4fea9a87a97fcd6c48b21b846e6a')

    await auth(stale, account, 'login')
    await stale.goto(detail)
    await start(stale, 'red')

    await controllerButton(page, 'x', 'green')
    await page.keyboard.down('r')
    try {
      await page.evaluate(async () => {
        for (let frame = 0; frame < 60; frame += 1) {
          await new Promise(requestAnimationFrame)
        }
      })
      await expectColor(page, 'green')
    } finally {
      await page.keyboard.up('r')
    }
    await pause(page)
    const exitButton = overlay(page).getByRole('button', { exact: true, name: 'Exit' })
    const resumeButton = overlay(page).getByRole('button', { exact: true, name: 'Resume' })
    const syncStatus = overlay(page).getByRole('status')
    await page.route(
      (url) => url.pathname === savePath,
      (route) => route.fulfill({ json: { message: 'Fixture write unavailable' }, status: 503 }),
      { times: 1 },
    )
    await syncButton(page).click()
    await expect(syncStatus).toHaveText('Could not sync your in-game save. Try again.')
    await expect(exitButton).toBeEnabled()
    await expect(resumeButton).toBeEnabled()

    const releaseWrite = Promise.withResolvers<undefined>()
    await page.route(
      (url) => url.pathname === savePath,
      async (route) => {
        await releaseWrite.promise
        await route.continue()
      },
      { times: 1 },
    )
    const pendingWrite = page.waitForRequest(
      (request) => new URL(request.url()).pathname === savePath && request.method() === 'PUT',
    )
    const saved = page.waitForResponse(
      (response) => new URL(response.url()).pathname === savePath && response.request().method() === 'PUT',
    )
    try {
      await syncButton(page).click()
      await pendingWrite
      await expect(syncStatus).toHaveText('Syncing in-game save…')
      await expect(exitButton).toBeDisabled()
      await expect(resumeButton).toBeDisabled()
      await page.keyboard.press('Escape')
    } finally {
      releaseWrite.resolve(undefined)
    }
    const write = await saved
    expect(write.ok(), await write.text()).toBe(true)
    const payload: { data: string; version: string | null } = write.request().postDataJSON()
    const batteryRam = Buffer.from(payload.data, 'base64')
    expect(batteryRam).toHaveLength(8192)
    expect(batteryRam[0]).toBe(0xa5)
    expect(payload.version).toBeNull()
    expect(write.headers()['cache-control']).toBe('private, no-store')
    await expect(syncStatus).toHaveText('In-game save synced.')
    await expect(exitButton).toBeEnabled()
    await expect(resumeButton).toBeEnabled()
    await expect(syncButton(page)).toHaveCSS('opacity', '1')
    const reportDirectory = path.dirname(
      process.env.RETROASSEMBLY_MOUNTED_TEST_REPORT || 'node_modules/.cache/ci/built-image.json',
    )
    await fs.mkdir(reportDirectory, { recursive: true })
    await page.screenshot({
      path: path.join(reportDirectory, `in-game-save-sync${basePath ? '-subpath' : ''}${upload ? '-upload' : ''}.png`),
    })
    await exit(page)

    await auth(fresh, account, 'login')
    await fresh.goto(detail)
    await expect(fresh.getByRole('button', { name: /^Continue\b/u })).toHaveCount(0)
    await start(fresh, 'green')
    await pause(fresh)
    await expect(overlay(fresh).getByRole('status')).toHaveText('In-game save loaded from your account.')
    await exit(fresh)

    await stale.bringToFront()
    await pause(stale)
    await syncButton(stale).click()
    await expect(overlay(stale).getByRole('status')).toHaveText(
      'The game or its synced save changed. Exit and choose Start to reload.',
    )
    await expect(syncButton(stale)).toBeDisabled()
    await overlay(stale).getByRole('button', { exact: true, name: 'Resume' }).click()
    await expect(overlay(stale)).not.toBeVisible()
    await expectColor(stale, 'red')
    await controllerButton(stale, 'z', 'blue')
    await pause(stale)
    const snapshot = stale.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === appPath('/api/v1/states') && response.request().method() === 'POST',
    )
    await exit(stale, 'Save & Exit')
    const stateResponse = await snapshot
    expect(stateResponse.ok()).toBe(true)

    await fresh.goto(detail)
    await start(fresh, 'blue', 'continue')
    await controllerButton(fresh, 'z', 'green')
    await pause(fresh)
    await exit(fresh)
    const fullscreenPreference = await fresh.request.post(appPath('/api/v1/preference'), {
      data: { emulator: { fullscreen: true } },
    })
    expect(fullscreenPreference.ok(), await fullscreenPreference.text()).toBe(true)
    await fresh.goto(detail)
    const releaseRead = Promise.withResolvers<undefined>()
    await fresh.route(
      (url) => url.pathname === savePath,
      async (route) => {
        await releaseRead.promise
        await route.fulfill({ json: { message: 'Fixture read unavailable' }, status: 503 })
      },
      { times: 1 },
    )
    const pendingRead = fresh.waitForRequest(
      (request) => new URL(request.url()).pathname === savePath && request.method() === 'GET',
    )
    const fullscreenStart = fresh.getByRole('button', { exact: true, name: 'Start' })
    try {
      await expect(fullscreenStart).toBeEnabled({ timeout: 90_000 })
      await fullscreenStart.click()
      await pendingRead
      await expect
        .poll(() => fresh.evaluate(() => document.fullscreenElement === document.body), { timeout: 3000 })
        .toBe(true)
    } finally {
      releaseRead.resolve(undefined)
    }
    await expectColor(fresh, 'red')
    expect(await fresh.evaluate(() => document.fullscreenElement === document.body)).toBe(true)
    await pause(fresh)
    await expect(overlay(fresh).getByRole('status')).toHaveText(
      'Could not load your in-game save. Exit and start again to retry.',
    )
    await expect(syncButton(fresh)).toBeDisabled()
    await exit(fresh)

    await auth(other, newAccount())
    await other.goto(gamePath(upload ? await findGame(other) : game))
    await start(other, 'red')
    await pause(other)
    await expect(overlay(other).getByRole('status')).toHaveText(
      'Save inside the game first, then sync to your account.',
    )
    if (!upload) {
      await overlay(other).getByRole('button', { exact: true, name: 'Resume' }).click()
      await expect(overlay(other)).not.toBeVisible()
      await controllerButton(other, 'x', 'green')
      await pause(other)
      await auth(other, newAccount())
      await syncButton(other).click()
      await expect(overlay(other).getByRole('status')).toHaveText(
        'The game or its synced save changed. Exit and choose Start to reload.',
      )
      await exit(other)
      await other.goto(detail)
      await start(other, 'red')
      await pause(other)
    }
    await exit(other)
  } finally {
    await staleContext.close()
    await freshContext.close()
    await otherContext.close()
  }
})

test('does not sync a compatible cartridge in demo mode', async ({ page }) => {
  const deployment = process.env.RETROASSEMBLY_MOUNTED_TEST_URL
  test.skip(!deployment, 'Requires isolated production acceptance')
  const basePath = new URL(deployment || '').pathname.replace(/\/$/u, '')
  await page.route(
    (url) =>
      url.origin === 'https://cdn.jsdelivr.net' &&
      /^\/gh\/retrobrews\/nes-games@[^/]+\/flappybird\.nes$/u.test(url.pathname),
    (route) =>
      route.fulfill({
        body: createSyntheticBatteryNesRom(),
        contentType: 'application/octet-stream',
        headers: { 'access-control-allow-origin': '*' },
      }),
  )
  const syncRequests: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/in-game-save')) {
      syncRequests.push(request.method())
    }
  })
  await page.goto(`${basePath}/demo/platform/nes/rom/flappybird.nes`)
  await start(page, 'red')
  await controllerButton(page, 'x', 'green')
  await pause(page)
  await expect(syncButton(page)).toHaveCount(0)
  await exit(page)
  expect(syncRequests).toEqual([])
})
