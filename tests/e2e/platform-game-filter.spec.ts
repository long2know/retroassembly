import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { syntheticFilterLastRomName, syntheticFilterRomCount } from './fixtures/synthetic-platform-filter.ts'

test.use({ viewport: { height: 960, width: 1280 } })

test('filters an authenticated console grid without changing global search or other consoles', async ({
  page,
}, testInfo) => {
  const deploymentUrl = process.env.RETROASSEMBLY_MOUNTED_TEST_URL
  test.skip(!deploymentUrl, 'Requires the mounted synthetic platform filter fixtures')
  const basePath = new URL(deploymentUrl || '').pathname.replace(/\/$/u, '')
  const nesPath = `${basePath}/library/platform/nes`
  const psxPath = `${basePath}/library/platform/psx`
  const registration = await page.request.post(`${basePath}/api/v1/auth/register`, {
    form: { password: `fixture-only-${randomUUID()}`, username: `filter-${randomUUID().slice(0, 8)}` },
  })
  expect(registration.ok(), await registration.text()).toBe(true)

  const grid = page.locator('main .game-entry')
  const main = page.getByRole('main')
  const input = main.getByRole('textbox', { exact: true, name: 'Filter games' })
  const lastGame = grid.and(page.getByTitle(`Homebrew/${syntheticFilterLastRomName}`, { exact: true }))
  const clear = main.getByRole('button', { exact: true, name: 'Clear game filter' })
  const noMatches = main.getByRole('status').filter({ hasText: 'No games match this filter.' })
  const globalSearch = page.getByRole('textbox', { exact: true, name: 'Search' })

  async function expectNesQuery(params: Record<string, string>) {
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === nesPath &&
        url.searchParams.size === Object.keys(params).length &&
        Object.entries(params).every(([key, value]) => url.searchParams.get(key) === value),
    )
  }

  await page.goto(nesPath)
  await expect(input).toHaveValue('')
  await expect(grid).toHaveCount(100)
  await expect(lastGame).toHaveCount(0)
  await main.getByRole('link', { exact: true, name: '2' }).click()
  await expectNesQuery({ page: '2' })
  await expect(lastGame).toBeVisible()
  const romId = new URL((await lastGame.getAttribute('href')) || '', page.url()).searchParams.get('rom_id')
  expect(romId).toBeTruthy()
  const title = await page.request.patch(`${basePath}/api/v1/roms/${romId}`, { form: { gameName: 'Café Comet' } })
  expect(title.ok(), await title.text()).toBe(true)
  await main.getByRole('link', { exact: true, name: '1' }).click()
  await expectNesQuery({ page: '1' })
  await expect(lastGame).toHaveCount(0)

  const historyLength = await page.evaluate(() => history.length)
  await input.pressSequentially('CafÉ comat')
  await input.press('ArrowLeft')
  await input.press('Backspace')
  await input.pressSequentially('e')
  await input.press('ArrowRight')
  await expect(input).toHaveValue('CafÉ comet')
  await expectNesQuery({ filter: 'CafÉ comet' })
  await expect(grid).toHaveCount(1)
  await expect(lastGame.getByText('Café Comet', { exact: true })).toBeVisible()
  await expect(input).toBeFocused()
  expect(await page.evaluate(() => history.length)).toBe(historyLength)

  const screenshotDirectory = path.dirname(
    process.env.RETROASSEMBLY_MOUNTED_TEST_REPORT || 'node_modules/.cache/ci/built-image.json',
  )
  const screenshot =
    process.env.RETROASSEMBLY_PLATFORM_FILTER_SCREENSHOT ||
    path.join(screenshotDirectory, `platform-game-filter${basePath ? '-subpath' : ''}.png`)
  await page.screenshot({ animations: 'disabled', path: screenshot })
  await testInfo.attach('filtered console', { contentType: 'image/png', path: screenshot })

  await input.press('ControlOrMeta+k')
  await expect(globalSearch).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(globalSearch).not.toBeVisible()
  await expect(input).toHaveValue('CafÉ comet')
  await expectNesQuery({ filter: 'CafÉ comet' })

  const cdp = await page.context().newCDPSession(page)
  await input.press('ControlOrMeta+a')
  await cdp.send('Input.imeSetComposition', { selectionEnd: 2, selectionStart: 2, text: '%_' })
  await expect(input).toHaveValue('%_')
  await page.waitForTimeout(350)
  await expectNesQuery({ filter: 'CafÉ comet' })
  await cdp.send('Input.insertText', { text: '%_' })
  await cdp.detach()
  await expectNesQuery({ filter: '%_' })
  await expect(grid).toHaveCount(1)
  await expect(lastGame).toBeVisible()
  await expect(input).toBeFocused()

  await clear.click()
  await expectNesQuery({})
  await expect(input).toHaveValue('')
  await expect(input).toBeFocused()
  await expect(grid).toHaveCount(100)

  await input.fill('Filter Shelf')
  await expectNesQuery({ filter: 'Filter Shelf' })
  await expect(main.getByText(`${syntheticFilterRomCount} games for NES.`, { exact: true })).toBeVisible()
  await main.getByRole('button', { exact: true, name: 'Sort' }).click()
  await page.getByRole('menuitem', { exact: true, name: 'Descending' }).click()
  await expectNesQuery({ direction: 'desc', filter: 'Filter Shelf', sort: 'name' })
  await expect(grid.first()).toHaveAttribute('title', `Homebrew/${syntheticFilterLastRomName}`)
  await main.getByRole('link', { exact: true, name: '2' }).click()
  await expectNesQuery({ direction: 'desc', filter: 'Filter Shelf', page: '2', sort: 'name' })
  await expect(grid).toHaveCount(1)
  await expect(grid.first()).toHaveAttribute('title', 'Homebrew/ZZ Filter Shelf 001.nes')

  await input.fill('%_')
  const sortedQuery = { direction: 'desc', filter: '%_', sort: 'name' }
  await expectNesQuery(sortedQuery)
  await expect(lastGame).toBeVisible()
  const card = lastGame.locator('..')
  await card.hover()
  const favoriteResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `${basePath}/api/v1/favorites` && response.request().method() === 'POST',
  )
  await card.getByRole('button', { exact: true, name: 'Add to favorites' }).click()
  const response = await favoriteResponse
  expect(response.ok()).toBe(true)
  await expect(card.getByRole('button', { exact: true, name: 'Remove from favorites' })).toBeVisible()
  await expectNesQuery(sortedQuery)
  await main.getByRole('link', { exact: true, name: 'Favorites' }).click()
  await expectNesQuery({ ...sortedQuery, favorite: '1' })
  await expect(input).toHaveValue('%_')
  await expect(lastGame).toBeVisible()

  await input.fill('No such favorite')
  await expectNesQuery({ ...sortedQuery, favorite: '1', filter: 'No such favorite' })
  await expect(noMatches).toBeVisible()
  await expect(main.getByText('some ROMs to get started.', { exact: false })).toHaveCount(0)

  await main.getByRole('button', { exact: true, name: 'Sort' }).click()
  await page.getByRole('menuitem', { exact: true, name: 'Date Added' }).click()
  const newSort = { direction: 'desc', sort: 'added' }
  const favoriteSort = { ...newSort, favorite: '1' }
  const favorites = main.getByRole('link', { exact: true, name: 'Favorites' })
  await expectNesQuery({ ...favoriteSort, filter: 'No such favorite' })
  await expect(noMatches).toBeVisible()
  await favorites.click()
  await expectNesQuery({ ...newSort, filter: 'No such favorite' })
  await expect(noMatches).toBeVisible()
  await favorites.click()
  await expectNesQuery({ ...favoriteSort, filter: 'No such favorite' })

  await input.fill('Cancel this pending edit')
  await input.press('Escape')
  await expectNesQuery(favoriteSort)
  await page.waitForTimeout(350)
  await expectNesQuery(favoriteSort)
  await expect(grid).toHaveCount(1)
  await expect(lastGame).toBeVisible()
  await expect(input).toHaveValue('')
  await expect(input).toBeFocused()

  await input.fill('Filter Shelf')
  await expectNesQuery({ ...favoriteSort, filter: 'Filter Shelf' })
  await page.locator(`.sidebar-link[href="${psxPath}"]`).click()
  await expect(page).toHaveURL((url) => url.pathname === psxPath && !url.search)
  await expect(input).toHaveValue('')
  await expect(grid.first()).toBeVisible()
  await input.fill('Filter Shelf')
  await expect(noMatches).toBeVisible()

  await page.locator('.sidebar-link.active').focus()
  await page.keyboard.press('ControlOrMeta+k')
  await expect(globalSearch).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(globalSearch).not.toBeVisible()
  await expect(input).toHaveValue('Filter Shelf')
  await page.locator('.sidebar-link.active').focus()
  await page.keyboard.press('Backspace')
  await expectNesQuery({ ...favoriteSort, filter: 'Filter Shelf' })
  await expect(input).toHaveValue('Filter Shelf')
  await expect(lastGame).toBeVisible()

  await page.goto(`${basePath}/demo/platform/nes?filter=Filter+Shelf`)
  await expect(input).toHaveCount(0)
  await expect(grid.first()).toBeVisible()
})
