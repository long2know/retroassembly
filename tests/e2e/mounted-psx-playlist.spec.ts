import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { MountedPlaylistState, MountedSource } from '../../src/constants/mounted-library.ts'
import { syntheticPsxPlaylist } from './fixtures/synthetic-psx.ts'

interface Save {
  fileId: string
  id: string
  playlist: MountedPlaylistState
}

type DiscColor = 'red' | 'green' | 'blue'

async function expectColor(page: Page, expected: DiscColor) {
  const canvas = page.locator('#canvas')
  await expect(canvas).toHaveCSS('opacity', '1')
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
        return await page.evaluate(async (base64) => {
          const response = await fetch(`data:image/png;base64,${base64}`)
          const image = await createImageBitmap(await response.blob())
          const ctx = new OffscreenCanvas(1, 1).getContext('2d')
          if (!ctx) {
            return 'none'
          }
          ctx.drawImage(image, 0, 0)
          const [red, green, blue] = ctx.getImageData(0, 0, 1, 1).data
          image.close()
          if (blue > 170 && red < 70 && green < 70) {
            return 'blue'
          }
          if (red > 170 && green < 70) {
            return 'red'
          }
          return green > 170 && red < 70 ? 'green' : 'other'
        }, png.toString('base64'))
      },
      { timeout: 15_000 },
    )
    .toBe(expected)
}

test('switches real mounted PlayStation discs lazily and restores private disc-bound saves', async ({ page }) => {
  const deployment = process.env.RETROASSEMBLY_MOUNTED_TEST_URL
  test.skip(!deployment, 'Requires the mounted synthetic PlayStation acceptance fixture')
  const basePath = new URL(deployment || '').pathname.replace(/\/$/u, '')
  function appPath(pathname: string) {
    return `${basePath}${pathname}`
  }
  const registration = await page.request.post(appPath('/api/v1/auth/register'), {
    form: { password: `fixture-only-${randomUUID()}`, username: `discs-${randomUUID().slice(0, 8)}` },
  })
  expect(registration.ok(), await registration.text()).toBe(true)
  const prefs = await page.request.post(appPath('/api/v1/preference'), {
    data: { emulator: { autoSaveInterval: 2 } },
  })
  expect(prefs.ok(), await prefs.text()).toBe(true)
  const resolvedPrefs = await page.request.get(appPath('/api/v1/preference'))
  expect(resolvedPrefs.ok(), await resolvedPrefs.text()).toBe(true)
  expect(await resolvedPrefs.json()).toMatchObject({ emulator: { platform: { psx: { rewindEnabled: true } } } })
  const listing = await page.request.get(appPath('/api/v1/roms/search?query=Disc%20Colors'))
  expect(listing.ok(), await listing.text()).toBe(true)
  const { roms }: { roms: { fileName: string; id: string; mountedSource: MountedSource }[] } = await listing.json()
  const rom = roms.find(({ fileName }) => fileName === syntheticPsxPlaylist)
  if (!rom?.mountedSource.playlist) {
    throw new Error('Production acceptance must provide the indexed PlayStation playlist')
  }
  const { id } = rom
  const { revision } = rom.mountedSource.playlist
  const discPath = appPath(`/api/v1/roms/${id}/discs/`)
  const getRequests: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.origin === new URL(deployment || '').origin && request.method() === 'GET') {
      getRequests.push(url.pathname)
    }
  })
  function requestedDiscs() {
    return getRequests
      .filter((pathname) => pathname.startsWith(discPath))
      .map((pathname) => pathname.slice(discPath.length))
  }
  const overlay = page.locator('.game-overlay')
  const choices = page.getByRole('group', { name: 'Change disc' })
  function disc(index: number) {
    return choices.getByRole('button', { exact: true, name: `Disc ${index}` })
  }
  async function pause() {
    await page.keyboard.press('Escape')
    await expect(choices).toBeVisible()
    await expect(overlay.getByRole('button', { exact: true, name: 'Resume' })).toBeFocused()
  }
  async function select(index: number) {
    await disc(index).press('Enter')
    await expect(disc(index)).toHaveAttribute('aria-pressed', 'true')
    await expect(disc(index)).toBeEnabled()
  }
  async function restartAndCheck(color: DiscColor) {
    await overlay.getByRole('button', { exact: true, name: 'Restart' }).click()
    await expect(overlay).not.toBeVisible()
    await expectColor(page, color)
  }
  async function findSave(type: 'auto' | 'manual') {
    const response = await page.request.get(appPath(`/api/v1/states?rom=${id}&type=${type}`))
    expect(response.ok(), await response.text()).toBe(true)
    const saves: Save[] = await response.json()
    return saves.find(({ playlist }) => playlist?.disc === 2 && playlist.revision === revision) ?? null
  }

  await page.goto(appPath(`/library/platform/psx/rom/${encodeURIComponent(rom.fileName)}?rom_id=${id}`))
  const start = page.getByRole('button', { exact: true, name: 'Start' })
  await expect(start).toBeEnabled({ timeout: 90_000 })
  await start.click()
  await expectColor(page, 'red')
  expect(requestedDiscs()).toEqual(['1'])
  await pause()
  await expect(disc(1)).toHaveAttribute('aria-pressed', 'true')
  await page.route(
    (url) => url.pathname === `${discPath}2`,
    (route) => route.fulfill({ json: { message: 'Fixture disc is unavailable' }, status: 503 }),
    { times: 1 },
  )
  await disc(2).press('Enter')
  await expect(overlay.getByRole('alert')).toHaveText(/Could not load the disc/u)
  await expect(disc(1)).toHaveAttribute('aria-pressed', 'true')
  expect(requestedDiscs()).toEqual(['1'])
  await select(3)
  expect(requestedDiscs()).toEqual(['1', '2', '3'])
  await restartAndCheck('blue')
  await pause()
  await select(1)
  await select(2)
  expect(requestedDiscs()).toEqual(['1', '2', '3'])

  const reportDirectory = path.dirname(
    process.env.RETROASSEMBLY_MOUNTED_TEST_REPORT || 'node_modules/.cache/ci/built-image.json',
  )
  await fs.mkdir(reportDirectory, { recursive: true })
  await page.screenshot({ path: path.join(reportDirectory, `psx-disc-switch${basePath ? '-subpath' : ''}.png`) })

  await restartAndCheck('green')
  await expect.poll(() => findSave('auto'), { timeout: 30_000 }).toMatchObject({ playlist: { disc: 2, revision } })
  const auto = await findSave('auto')
  if (!auto) {
    throw new Error('Expected the automatic save on disc two')
  }
  await pause()
  await expect(overlay.getByRole('button', { name: 'Load an external state' })).toHaveCount(0)
  await overlay.getByRole('button', { exact: true, name: 'Save & Exit' }).click()
  await expect(page.locator('#canvas')).not.toBeAttached()
  const manual = await findSave('manual')
  expect(manual?.playlist).toEqual({ disc: 2, revision })

  getRequests.length = 0
  const resume = page.getByRole('button', { name: /^Continue\b/u })
  await expect(resume).toBeEnabled({ timeout: 90_000 })
  await resume.click()
  await expectColor(page, 'green')
  const discRequest = getRequests.indexOf(`${discPath}2`)
  const stateRequest = getRequests.indexOf(appPath(`/api/v1/files/${encodeURIComponent(manual?.fileId || '')}`))
  expect(discRequest).toBeGreaterThanOrEqual(0)
  expect(stateRequest).toBeGreaterThan(discRequest)

  await pause()
  await expect(disc(2)).toHaveAttribute('aria-pressed', 'true')
  expect(requestedDiscs()).not.toContain('3')
  function isDiscThree(url: URL) {
    return url.pathname === `${discPath}3`
  }
  await page.route(isDiscThree, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { message: 'Fixture disc download failed' }, status: 503 })
      : route.continue(),
  )
  const head = page.waitForResponse(
    (response) => isDiscThree(new URL(response.url())) && response.request().method() === 'HEAD',
  )
  const failedDownload = page.waitForResponse(
    (response) => isDiscThree(new URL(response.url())) && response.request().method() === 'GET',
  )
  await disc(3).press('Enter')
  const [headResponse, failedResponse] = await Promise.all([head, failedDownload])
  expect(headResponse.status()).toBe(200)
  expect(failedResponse.status()).toBe(503)
  await expect(overlay.getByRole('alert')).toHaveText(/Could not load the disc/u)
  await expect(disc(2)).toHaveAttribute('aria-pressed', 'true')
  await expect(disc(3)).toBeEnabled()
  await page.unroute(isDiscThree)
  const retry = page.waitForResponse(
    (response) => isDiscThree(new URL(response.url())) && response.request().method() === 'GET',
  )
  await select(3)
  const retryResponse = await retry
  expect(retryResponse.status()).toBe(200)
  await expect(overlay.getByRole('alert')).toHaveCount(0)

  await select(1)
  await restartAndCheck('red')
  await pause()
  const savedState = overlay.locator('button.game-state').filter({ has: page.getByAltText(auto.id, { exact: true }) })
  await expect(savedState).toBeEnabled()
  await savedState.press('Enter')
  await expect(overlay).not.toBeVisible()
  await expectColor(page, 'green')
  await pause()
  await expect(disc(2)).toHaveAttribute('aria-pressed', 'true')
  await expect(overlay.getByText('Escape', { exact: true })).toBeVisible()
  await expect(overlay.getByText('Rewind')).toHaveCount(0)

  const desktopViewport = page.viewportSize()
  if (!desktopViewport) {
    throw new Error('Expected the acceptance viewport')
  }
  await page.setViewportSize({ height: 844, width: 390 })
  await expect(page.getByTitle('Fast forward', { exact: true })).toBeVisible()
  await expect(page.getByTitle('Rewind', { exact: true })).toHaveCount(0)
  await page.setViewportSize(desktopViewport)
  await page.evaluate(() => {
    const gamepad = {
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
      connected: true,
      id: 'Acceptance controller',
      index: 0,
      mapping: 'standard',
      timestamp: 0,
    }
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [gamepad] })
    globalThis.dispatchEvent(Object.assign(new Event('gamepadconnected'), { gamepad }))
  })
  await expect(overlay.getByText('Escape', { exact: true })).toHaveCount(0)
  await expect(overlay.getByText('Fast forward')).toBeVisible()
  await expect(overlay.getByText('Rewind')).toHaveCount(0)
  await overlay.getByRole('button', { exact: true, name: 'Exit' }).click()
  await expect(page.locator('#canvas')).not.toBeAttached()
})
