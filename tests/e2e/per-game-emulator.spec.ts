import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

function chooser(target: Page) {
  return target.getByRole('combobox', { exact: true, name: 'Emulator for this game' })
}

function continueButton(target: Page) {
  return target.getByRole('button', { name: /^Continue\b/u })
}

async function choose(target: Page, name: string) {
  await chooser(target).click()
  await target.getByRole('option', { exact: true, name }).click()
}

test('uses private per-game emulator choices for actual browser play and compatible saves', async ({
  browser,
  page,
}) => {
  const deployment = process.env.RETROASSEMBLY_MOUNTED_TEST_URL
  test.skip(!deployment, 'Requires the mounted synthetic NES acceptance fixture')
  const basePath = new URL(deployment || '').pathname.replace(/\/$/u, '')
  function appPath(pathname: string) {
    return `${basePath}${pathname}`
  }

  async function register(target: Page) {
    const response = await target.request.post(appPath('/api/v1/auth/register'), {
      form: { password: `fixture-only-${randomUUID()}`, username: `core-${randomUUID().slice(0, 8)}` },
    })
    expect(response.ok(), await response.text()).toBe(true)
  }

  await register(page)
  const listing = await page.request.get(appPath('/api/v1/roms/search?query=Immutable%20Pulse'))
  expect(listing.ok(), await listing.text()).toBe(true)
  const { roms }: { roms: { fileName: string; id: string; platform: string }[] } = await listing.json()
  const rom = roms.find(({ fileName }) => fileName === 'Homebrew/Immutable Pulse.nes')
  if (!rom) {
    throw new Error('Production acceptance must provide the synthetic NES fixture')
  }
  const { id: romId } = rom
  const romPath = appPath(`/library/platform/${rom.platform}/rom/${encodeURIComponent(rom.fileName)}?rom_id=${romId}`)
  const coreEndpoint = appPath(`/api/v1/preference/roms/${romId}/core`)
  const coreAssets = new Set<string>()
  const fileRequests = new Set<string>()
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (response.ok() && url.pathname.endsWith('_libretro.zip')) {
      coreAssets.add(path.basename(url.pathname))
    }
  })
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.startsWith(appPath('/api/v1/files/')) && request.method() === 'GET') {
      fileRequests.add(url.pathname)
    }
  })

  function stateUrl(fileId: string) {
    return appPath(`/api/v1/files/${encodeURIComponent(fileId)}`)
  }

  async function launch(button: 'Continue' | 'Start', core: string) {
    const launched = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === appPath('/api/v1/launch_records') &&
        response.request().method() === 'POST',
    )
    const control =
      button === 'Continue' ? continueButton(page) : page.getByRole('button', { exact: true, name: 'Start' })
    await expect(control).toBeEnabled({ timeout: 90_000 })
    await control.click()
    const response = await launched
    expect(response.ok(), await response.text()).toBe(true)
    const request = response.request()
    const form = await new Response(request.postData(), { headers: await request.allHeaders() }).formData()
    expect(Object.fromEntries(form)).toMatchObject({ core, rom: romId })
    await expect(page.locator('#canvas')).toHaveCSS('opacity', '1', { timeout: 90_000 })
    expect(coreAssets.has(`${core}_libretro.zip`)).toBe(true)
  }

  async function saveAndExit(core: string) {
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { exact: true, name: 'Save & Exit' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sync in-game save' })).toHaveCount(0)
    const saved = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === appPath('/api/v1/states') && response.request().method() === 'POST',
    )
    await page.getByRole('button', { exact: true, name: 'Save & Exit' }).click()
    const response = await saved
    expect(response.ok(), await response.text()).toBe(true)
    const state: { core: string; fileId: string; romId: string } = await response.json()
    expect(state).toMatchObject({ core, romId })
    await expect(page.locator('#canvas')).not.toBeAttached()
    await expect(continueButton(page)).toBeEnabled({ timeout: 90_000 })
    return state.fileId
  }

  await page.goto(romPath)
  await expect(chooser(page)).toHaveText('Platform default (FCEUmm)')
  await launch('Start', 'fceumm')
  const defaultState = await saveAndExit('fceumm')

  await page.route(
    (url) => url.pathname === coreEndpoint,
    async (route) => {
      await expect(chooser(page)).toBeDisabled()
      await expect(continueButton(page)).toBeDisabled()
      await route.fulfill({ json: { message: 'Fixture write failure' }, status: 503 })
    },
    { times: 1 },
  )
  await choose(page, 'Nestopia')
  await expect(page.getByRole('alert')).toHaveText('Could not save your emulator choice. Please try again.')
  await expect(chooser(page)).toHaveText('Platform default (FCEUmm)')

  const detailDataPath = `${new URL(romPath, page.url()).pathname}.data`
  const revalidated = page.waitForResponse((response) => new URL(response.url()).pathname === detailDataPath)
  await page.route(
    (url) => url.pathname === detailDataPath,
    async (route) => {
      await expect(chooser(page)).toBeDisabled()
      await expect(continueButton(page)).toBeDisabled()
      await route.continue()
    },
    { times: 1 },
  )
  fileRequests.clear()
  await choose(page, 'Nestopia')
  const detailResponse = await revalidated
  expect(detailResponse.ok()).toBe(true)
  await expect(chooser(page)).toHaveText('Nestopia')
  await expect(continueButton(page)).toHaveCount(0)
  await expect(page.getByRole('button', { exact: true, name: 'Start' })).toBeEnabled({ timeout: 90_000 })
  expect(fileRequests.has(stateUrl(defaultState))).toBe(false)
  const platformResponse = await page.request.get(appPath('/api/v1/preference'))
  expect(await platformResponse.json()).toMatchObject({ emulator: { platform: { nes: { core: 'fceumm' } } } })

  fileRequests.clear()
  await page.goto(appPath('/library'))
  await expect(continueButton(page)).toHaveCount(0)
  await launch('Start', 'nestopia')
  expect(fileRequests.has(stateUrl(defaultState))).toBe(false)
  const alternateState = await saveAndExit('nestopia')

  await page.goto(romPath)
  await expect(chooser(page)).toHaveText('Nestopia')
  await expect(continueButton(page)).toBeEnabled({ timeout: 90_000 })
  const screenshotDirectory = path.dirname(
    process.env.RETROASSEMBLY_MOUNTED_TEST_REPORT || 'node_modules/.cache/ci/built-image.json',
  )
  await fs.mkdir(screenshotDirectory, { recursive: true })
  await page.screenshot({ path: path.join(screenshotDirectory, `per-game-emulator${basePath ? '-subpath' : ''}.png`) })

  const otherContext = await browser.newContext({ baseURL: deployment })
  try {
    const other = await otherContext.newPage()
    await register(other)
    await other.goto(romPath)
    await expect(chooser(other)).toHaveText('Platform default (FCEUmm)')
    await expect(continueButton(other)).toHaveCount(0)
    await choose(other, 'FCEUmm')
    await expect(chooser(other)).toHaveText('FCEUmm')
  } finally {
    await otherContext.close()
  }

  await page.reload()
  await expect(chooser(page)).toHaveText('Nestopia')
  await choose(page, 'Platform default (FCEUmm)')
  await expect(chooser(page)).toHaveText('Platform default (FCEUmm)')
  fileRequests.clear()
  await page.reload()
  await expect(continueButton(page)).toBeEnabled({ timeout: 90_000 })
  expect(fileRequests.has(stateUrl(defaultState))).toBe(true)
  expect(fileRequests.has(stateUrl(alternateState))).toBe(false)

  await page.getByRole('button', { exact: true, name: 'Menu' }).click()
  await page.getByRole('menuitem', { exact: true, name: 'Settings' }).click()
  const settings = page.getByRole('dialog', { exact: true, name: 'Settings' })
  await settings.getByRole('tab', { exact: true, name: 'Emulating' }).click()
  await settings.getByRole('combobox').filter({ hasText: 'FCEUmm' }).click()
  await page.getByRole('option', { exact: true, name: 'Nestopia' }).click()
  await expect(settings.getByRole('combobox').filter({ hasText: 'Nestopia' })).toBeEnabled()
  await settings.getByTitle('Close', { exact: true }).click()
  await expect(chooser(page)).toHaveText('Platform default (Nestopia)')

  fileRequests.clear()
  await page.goto(appPath('/library'))
  await launch('Continue', 'nestopia')
  expect(fileRequests.has(stateUrl(alternateState))).toBe(true)
  expect(fileRequests.has(stateUrl(defaultState))).toBe(false)
})
