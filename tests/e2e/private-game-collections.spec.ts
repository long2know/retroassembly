import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { syntheticPsxPlaylist } from './fixtures/synthetic-psx.ts'

test.use({ locale: 'en-US', viewport: { height: 800, width: 1280 } })

function chooser(target: Page) {
  return target.getByRole('dialog', { name: 'Collections' })
}

async function createCollection(target: Page, name: string) {
  await target.getByRole('button', { name: 'New collection' }).click()
  const field = target.getByRole('textbox', { name: 'Collection name' })
  await expect(field).toBeFocused()
  await field.fill(name)
  await field.press('Enter')
  await expect(target.getByRole('heading', { exact: true, name: name.trim() })).toBeVisible()
  const location = new URL(target.url())
  expect(location.pathname).toMatch(/\/library\/collections\/[a-z0-9_-]+$/iu)
  expect(location.search).toBe('')
  return location.pathname
}

test('manages private collections across platforms without changing mounted games', async ({ browser, page }) => {
  const deployment = process.env.RETROASSEMBLY_MOUNTED_TEST_URL
  test.skip(!deployment, 'Requires the mounted synthetic NES and PSX acceptance fixtures')
  const { origin, pathname } = new URL(deployment || '')
  const basePath = pathname.replace(/\/$/u, '')
  const collectionsPath = `${basePath}/library/collections`
  const endpoint = `${basePath}/api/v1/collections`
  const parentName = 'Couch co-op'
  const renamed = 'Weekend picks'

  function appPath(pathname: string) {
    return `${basePath}${pathname}`
  }

  async function register(target: Page) {
    const response = await target.request.post(appPath('/api/v1/auth/register'), {
      form: { password: `fixture-only-${randomUUID()}`, username: `collection-${randomUUID().slice(0, 8)}` },
    })
    expect(response.ok(), await response.text()).toBe(true)
  }

  async function findRom(fileName: string, platform: string) {
    const query = new URLSearchParams({ platform, query: path.parse(fileName).name })
    const response = await page.request.get(appPath(`/api/v1/roms/search?${query}`))
    expect(response.ok(), await response.text()).toBe(true)
    const { roms }: { roms: { fileName: string; id: string }[] } = await response.json()
    const rom = roms.find((entry) => entry.fileName === fileName)
    if (!rom) {
      throw new Error(`Production acceptance must provide synthetic fixture ${fileName}`)
    }
    const detailPath = appPath(`/library/platform/${platform}/rom/${encodeURIComponent(fileName)}?rom_id=${rom.id}`)
    return { detailPath, id: rom.id }
  }

  async function showChooser(target: Page, detailPath: string) {
    await target.goto(detailPath)
    await target.getByRole('button', { exact: true, name: 'Collections' }).click()
    return chooser(target)
  }

  const anonymous = await page.request.post(endpoint, { data: { name: parentName } })
  expect(anonymous.status()).toBe(401)
  expect(anonymous.headers()['cache-control']).toBe('private, no-store')
  await page.goto(collectionsPath)
  expect(new URL(page.url()).pathname).toBe(appPath('/login'))
  await page.goto(appPath('/demo'))
  await expect(page.getByRole('link', { exact: true, name: 'Collections' })).toHaveCount(0)

  await register(page)
  const preferenceEndpoint = appPath('/api/v1/preference')
  const preference = await page.request.post(preferenceEndpoint, { data: { ui: { platforms: ['nes'] } } })
  expect(preference.ok(), await preference.text()).toBe(true)
  const [nes, psx] = await Promise.all([
    findRom('Homebrew/Immutable Pulse.nes', 'nes'),
    findRom(syntheticPsxPlaylist, 'psx'),
  ])
  const contentPath = appPath(`/api/v1/roms/${nes.id}/content`)
  async function contentHash() {
    const response = await page.request.get(contentPath)
    expect(response.status()).toBe(200)
    return createHash('sha256')
      .update(await response.body())
      .digest('hex')
  }
  const original = await contentHash()
  if (process.env.RETROASSEMBLY_MOUNTED_TEST_ROM_SHA256) {
    expect(original).toBe(process.env.RETROASSEMBLY_MOUNTED_TEST_ROM_SHA256)
  }

  await page.goto(appPath('/library'))
  await page.getByRole('link', { exact: true, name: 'Collections' }).click()
  await expect(page.getByText('No collections yet.', { exact: false })).toBeVisible()
  const collectionPath = await createCollection(page, `  ${parentName}  `)
  const collectionId = collectionPath.split('/').at(-1)
  const memberPath = `${endpoint}/${collectionId}/roms/${nes.id}`
  await expect(page.getByText('No games available in this collection.', { exact: false })).toBeVisible()

  await page.goto(collectionsPath)
  await page.getByRole('button', { name: 'New collection' }).click()
  const duplicateDialog = page.getByRole('dialog', { name: 'New collection' })
  await duplicateDialog.getByRole('textbox', { name: 'Collection name' }).fill(' couch CO-OP ')
  await duplicateDialog.getByRole('button', { exact: true, name: 'Save' }).click()
  await expect(duplicateDialog.getByRole('alert')).toHaveText('You already have a collection with that name.')
  await duplicateDialog.getByRole('button', { name: 'Cancel' }).click()

  const nesChooser = await showChooser(page, nes.detailPath)
  const addNes = nesChooser.getByRole('button', { name: `Add to ${parentName}` })
  await page.route(
    (url) => url.pathname === memberPath,
    async (route) => {
      await expect(addNes).toBeDisabled()
      await route.fulfill({ json: { message: 'Synthetic save failure' }, status: 503 })
    },
    { times: 1 },
  )
  await addNes.click()
  await expect(nesChooser.getByRole('alert')).toHaveText('Could not save your collection changes. Please try again.')
  await addNes.click()
  await expect(nesChooser.getByRole('button', { name: `Remove from ${parentName}` })).toBeEnabled()
  await nesChooser.getByRole('button', { name: 'Done' }).click()

  const psxChooser = await showChooser(page, psx.detailPath)
  await psxChooser.getByRole('button', { name: `Add to ${parentName}` }).click()
  await expect(psxChooser.getByRole('button', { name: `Remove from ${parentName}` })).toBeEnabled()
  await psxChooser.getByRole('link', { name: 'Manage collections' }).click()
  await page.getByRole('link', { name: `${parentName} Games: 2` }).click()
  await expect(page).toHaveURL(new URL(collectionPath, origin).href)
  const ownerDocument = await page.reload()
  expect(ownerDocument?.headers()['cache-control']).toBe('private, no-store')
  expect(new URL(page.url()).pathname).toBe(collectionPath)
  const main = page.getByRole('main')
  const nesCard = main.locator('.game-entry').filter({ hasText: /Immutable Pulse/iu })
  const psxCard = main.locator('.game-entry').filter({ hasText: /Disc Colors/iu })
  await expect(nesCard).toHaveAttribute('href', nes.detailPath)
  await expect(psxCard).toHaveAttribute('href', psx.detailPath)
  await expect(main.getByText('Games: 2')).toBeVisible()
  const currentPreference = await page.request.get(preferenceEndpoint)
  expect(await currentPreference.json()).toMatchObject({ ui: { platforms: ['nes'] } })

  const screenshotDirectory = path.dirname(
    process.env.RETROASSEMBLY_MOUNTED_TEST_REPORT || 'node_modules/.cache/ci/built-image.json',
  )
  const screenshotPath =
    process.env.RETROASSEMBLY_PRIVATE_COLLECTIONS_SCREENSHOT ||
    path.join(screenshotDirectory, `private-game-collections${basePath ? '-subpath' : ''}.png`)
  await fs.mkdir(path.dirname(screenshotPath), { recursive: true })
  await page.screenshot({ animations: 'disabled', path: screenshotPath })

  const otherContext = await browser.newContext({
    baseURL: origin,
    locale: 'en-US',
    viewport: { height: 844, width: 390 },
  })
  try {
    const other = await otherContext.newPage()
    await register(other)
    await other.goto(appPath('/library'))
    await other.getByRole('banner').getByRole('combobox').click()
    await other.getByRole('option', { exact: true, name: 'Collections' }).click()
    await expect(other.getByRole('heading', { exact: true, name: 'Collections' })).toBeVisible()
    await expect(other.getByText('No collections yet.', { exact: false })).toBeVisible()
    const denied = await other.goto(collectionPath)
    expect(denied?.status()).toBe(404)
    expect(denied?.headers()['cache-control']).toBe('private, no-store')
    expect(await denied?.text()).not.toContain(parentName)
    const deniedData = await other.request.get(`${collectionPath}.data`)
    expect(deniedData.status()).toBe(404)
    expect(deniedData.headers()['cache-control']).toBe('private, no-store')
    expect(await deniedData.text()).not.toContain(parentName)
    const foreignRemove = await other.request.delete(memberPath)
    expect(foreignRemove.status()).toBe(404)
    const foreignRename = await other.request.patch(`${endpoint}/${collectionId}`, { data: { name: 'Not mine' } })
    expect(foreignRename.status()).toBe(404)

    const otherChooser = await showChooser(other, nes.detailPath)
    await expect(otherChooser.getByText('No collections yet.', { exact: false })).toBeVisible()
    await otherChooser.getByRole('link', { name: 'Manage collections' }).click()
    const otherPath = await createCollection(other, parentName)
    expect(otherPath).not.toBe(collectionPath)
    const ownChooser = await showChooser(other, nes.detailPath)
    await ownChooser.getByRole('button', { name: `Add to ${parentName}` }).click()
    await expect(chooser(other).getByRole('button', { name: `Remove from ${parentName}` })).toBeEnabled()
    await other.goto(otherPath)
    await expect(other.getByRole('main').getByText('Games: 1')).toBeVisible()
  } finally {
    await otherContext.close()
  }

  await test.step('browser Back from an open collection dialog restores spatial navigation', async () => {
    await psxCard.click()
    await expect(page).toHaveURL(new URL(psx.detailPath, origin).href)
    await page.getByRole('button', { exact: true, name: 'Collections' }).click()
    await expect(chooser(page)).toBeVisible()

    await page.goBack()
    await expect(page).toHaveURL(new URL(collectionPath, origin).href)
    await expect(chooser(page)).toBeHidden()
    await psxCard.focus()
    await expect(psxCard).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect(nesCard).toBeFocused()
  })

  await psxCard.click()
  await expect(page).toHaveURL(new URL(psx.detailPath, origin).href)
  await page.getByRole('button', { exact: true, name: 'Collections' }).click()
  await chooser(page)
    .getByRole('button', { name: `Remove from ${parentName}` })
    .click()
  await expect(chooser(page).getByRole('button', { name: `Add to ${parentName}` })).toBeEnabled()
  await chooser(page).getByRole('button', { name: 'Done' }).click()
  await page.goBack()
  await expect(main.getByText('Games: 1')).toBeVisible()
  await expect(psxCard).toHaveCount(0)
  await main.getByRole('button', { name: /Remove Immutable Pulse.*from this collection/iu }).click()
  await expect(main.getByText('Games: 0')).toBeVisible()
  await expect(nesCard).toHaveCount(0)
  expect(await contentHash()).toBe(original)

  const readd = await showChooser(page, nes.detailPath)
  await readd.getByRole('button', { name: `Add to ${parentName}` }).click()
  await expect(chooser(page).getByRole('button', { name: `Remove from ${parentName}` })).toBeEnabled()
  await page.goto(collectionPath)
  await page.getByRole('button', { name: 'Rename collection' }).click()
  const rename = page.getByRole('dialog', { name: 'Rename collection' })
  await rename.getByRole('textbox', { name: 'Collection name' }).fill(renamed)
  await rename.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('heading', { exact: true, name: renamed })).toBeVisible()
  expect(new URL(page.url()).pathname).toBe(collectionPath)
  await expect(main.getByText('Games: 1')).toBeVisible()

  const deleteTrigger = page.getByRole('button', { name: 'Delete collection' })
  await deleteTrigger.click()
  const confirmation = page.getByRole('alertdialog', { name: 'Delete collection' })
  await expect(confirmation).toContainText(`Delete “${renamed}”? The games will stay in your library.`)
  await confirmation.getByRole('button', { name: 'Cancel' }).click()
  await expect(nesCard).toBeVisible()
  await deleteTrigger.click()
  await confirmation.getByRole('button', { exact: true, name: 'Delete' }).click()
  await expect(page.getByText('No collections yet.', { exact: false })).toBeVisible()
  expect(new URL(page.url()).pathname).toBe(collectionsPath)
  const deleted = await page.request.get(collectionPath)
  expect(deleted.status()).toBe(404)
  expect(await contentHash()).toBe(original)

  await page.goto(nes.detailPath)
  const launch = page.getByRole('button', { exact: true, name: 'Start' })
  await expect(launch).toBeEnabled({ timeout: 90_000 })
  const launchRecord = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === appPath('/api/v1/launch_records') && response.request().method() === 'POST',
  )
  await launch.click()
  const launched = await launchRecord
  expect(launched.ok()).toBe(true)
  await expect(page.locator('#canvas')).toHaveCSS('opacity', '1', { timeout: 90_000 })
})
