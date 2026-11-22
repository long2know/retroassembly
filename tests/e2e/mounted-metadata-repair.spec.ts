import { fork, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { build } from 'esbuild'
import { z } from 'zod'
import { catalogTitles, syntheticCover } from './fixtures/synthetic-catalog.ts'

const romSchema = z.object({
  fileName: z.string(),
  gameBoxartFileIds: z.string().nullable(),
  gameName: z.string().nullable(),
  id: z.string(),
})

function hash(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

function appAddress(origin: string, basePath: string) {
  return function appUrl(relative: string) {
    return `${origin}${basePath}${relative}`
  }
}

function waitForOrigin(server: ChildProcess, providers: string[]) {
  return new Promise<string>(function listen(resolve, reject) {
    const timeout = setTimeout(() => reject(new Error('Isolated production server did not start')), 15_000)
    server.once('error', reject)
    server.once('exit', (code) => {
      clearTimeout(timeout)
      reject(new Error(`Isolated production server exited (${code})`))
    })
    server.on('message', (message) => {
      if (typeof message === 'object' && message) {
        if ('port' in message) {
          clearTimeout(timeout)
          resolve(`http://127.0.0.1:${message.port}`)
        } else if ('provider' in message && typeof message.provider === 'string') {
          providers.push(message.provider)
        }
      }
    })
  })
}

for (const basePath of ['', '/fixtures/retro']) {
  test(`chooses and repairs a mounted title in the production UI at ${basePath || '/'}`, async ({ page }, testInfo) => {
    const root = path.resolve('node_modules/.cache', `metadata-browser-${randomUUID()}`)
    const romDirectory = path.join(root, 'roms', 'nes')
    const dataDirectory = path.join(root, 'data')
    const fixtureFile = path.join(romDirectory, 'Unknown cartridge.nes')
    await mkdir(romDirectory, { recursive: true })
    await mkdir(dataDirectory)
    await writeFile(fixtureFile, 'Synthetic fixture; not an actual commercial game.')
    const initialHash = hash(await readFile(fixtureFile))
    const { mtimeMs } = await stat(fixtureFile)
    let server: ChildProcess | undefined
    let logs = ''
    const providers: string[] = []
    try {
      const host = path.join(root, 'host.mjs')
      await build({
        bundle: true,
        entryPoints: ['tests/e2e/fixtures/mounted-metadata-host.ts'],
        format: 'esm',
        outfile: host,
        packages: 'external',
        platform: 'node',
      })
      server = fork(host, {
        env: {
          ...process.env,
          BASE_URL: basePath,
          NODE_ENV: 'production',
          RETROASSEMBLY_RUN_TIME_DATA_DIRECTORY: dataDirectory,
          RETROASSEMBLY_RUN_TIME_ENABLE_SHARED_ROM_LIBRARY: 'true',
          RETROASSEMBLY_RUN_TIME_MSLEUTH_FALLBACK_HOST: '',
          RETROASSEMBLY_RUN_TIME_MSLEUTH_HOST: 'https://metadata.fixture.invalid',
          RETROASSEMBLY_RUN_TIME_OIDC_CLIENT_ID: '',
          RETROASSEMBLY_RUN_TIME_OIDC_CLIENT_SECRET: '',
          RETROASSEMBLY_RUN_TIME_OIDC_ISSUER: '',
          RETROASSEMBLY_RUN_TIME_SHARED_BIOS_DIRECTORY: '',
          RETROASSEMBLY_RUN_TIME_SHARED_LIBRARY_ONLY: 'true',
          RETROASSEMBLY_RUN_TIME_SHARED_ROM_DIRECTORY: path.join(root, 'roms'),
          RETROASSEMBLY_RUN_TIME_SHARED_ROM_METADATA_ENABLED: 'true',
          RETROASSEMBLY_RUN_TIME_SHARED_ROM_SCAN_INTERVAL: '0',
          RETROASSEMBLY_RUN_TIME_STORAGE_DIRECTORY: path.join(dataDirectory, 'storage'),
          RETROASSEMBLY_RUN_TIME_SUPABASE_ANON_KEY: '',
          RETROASSEMBLY_RUN_TIME_SUPABASE_URL: '',
        },
        execArgv: [],
        silent: true,
      })
      server.stdout?.on('data', (line) => {
        logs += String(line)
      })
      server.stderr?.on('data', (line) => {
        logs += String(line)
      })
      const origin = await waitForOrigin(server, providers)
      const appUrl = appAddress(origin, basePath)
      const externalProviderRequests: string[] = []
      const legacyArtworkRequests: string[] = []
      const legacyCover = syntheticCover()
      await page.route('**/*', (route) => {
        const { origin: requestedOrigin, pathname } = new URL(route.request().url())
        if (requestedOrigin === origin) {
          return route.continue()
        }
        if (
          requestedOrigin === 'https://thumbnails.libretro.com' &&
          decodeURIComponent(pathname).endsWith('/Legacy Lantern (World).png')
        ) {
          legacyArtworkRequests.push(pathname)
          return pathname.includes('/Named_Titles/')
            ? route.fulfill({ body: legacyCover, contentType: 'image/png' })
            : route.fulfill({ status: 404 })
        }
        if (
          ['https://raw.githubusercontent.com', 'https://thumbnails.libretro.com'].includes(requestedOrigin) ||
          route.request().url().includes('/libretro-thumbnails/')
        ) {
          externalProviderRequests.push(route.request().url())
        }
        return route.abort()
      })
      const registered = await page.request.post(appUrl('/api/v1/auth/register'), {
        form: { password: `fixture-only-${randomUUID()}`, username: 'repair-test' },
      })
      expect(registered.status(), await registered.text()).toBe(200)
      const response = await page.request.get(appUrl('/api/v1/roms'))
      const { roms } = z.object({ roms: z.array(romSchema) }).parse(await response.json())
      expect(roms.map(({ fileName }) => fileName)).toEqual(['Unknown cartridge.nes'])
      const [rom] = roms
      const detailsUrl = appUrl(`/library/platform/nes/rom/${encodeURIComponent(rom.fileName)}?rom_id=${rom.id}`)
      await page.goto(detailsUrl)
      await expect(page.getByRole('heading', { name: 'Unknown cartridge' })).toBeVisible()
      expect(providers).toEqual([])

      await page.getByRole('button', { name: 'Find match' }).click()
      const dialog = page.getByRole('dialog', { name: 'Find match' })
      const query = dialog.getByRole('textbox', { name: 'Game title or arcade set name' })
      await query.fill('not in this catalog')
      await query.press('Enter')
      await expect(dialog.getByText('No matches on this platform.', { exact: false })).toBeVisible()
      await query.fill('circuit lan')
      await dialog.getByRole('button', { name: 'Search' }).click()
      await expect(dialog.getByRole('button', { name: /^Use match:/u })).toHaveCount(3)
      await expect(dialog.getByRole('button', { name: /Circuit Lantern II.*Europe.*Rev 1.*1996/u })).toBeVisible()
      const unedited = await page.request.get(appUrl(`/api/v1/roms/${rom.id}`))
      const uneditedRom = romSchema.parse(await unedited.json())
      expect(uneditedRom.gameName).toBeNull()
      expect(providers).toEqual(['https://raw.githubusercontent.com'])

      const screenshot = await page.screenshot({
        animations: 'disabled',
        path: basePath ? undefined : process.env.RETROASSEMBLY_MOUNTED_METADATA_SCREENSHOT,
      })
      await testInfo.attach('mounted-metadata-match-results', { body: screenshot, contentType: 'image/png' })

      await dialog.getByRole('button', { name: /Circuit Lantern II.*Europe/u }).click()
      await expect(dialog.getByText('Match saved. No replacement cover was found.')).toBeVisible()
      await dialog.getByRole('button', { name: 'Close' }).click()
      await page.reload()
      await expect(page).toHaveURL(detailsUrl)
      await expect(page.getByRole('heading', { name: 'Circuit Lantern II' })).toBeVisible()
      await expect(page.getByText('No replacement cover was found.')).toBeVisible()
      await expect(page.getByText('1996', { exact: true })).toBeVisible()

      await page.getByRole('button', { name: 'Retry cover art' }).click()
      await expect(page.getByText('Cover art is ready.')).toBeVisible()
      const repaired = await page.request.get(appUrl(`/api/v1/roms/${rom.id}`))
      const { gameBoxartFileIds } = romSchema.parse(await repaired.json())
      const fileId = z
        .string()
        .regex(/^metadata\//u)
        .parse(gameBoxartFileIds)
      const coverPath = `/api/v1/files/${encodeURIComponent(fileId)}`
      const art = await page.request.get(appUrl(coverPath))
      expect(art.status()).toBe(200)
      expect(hash(await art.body())).toBe(hash(syntheticCover()))
      await page.reload()
      const renderedCover = page.locator(`a img[src="${basePath}${coverPath}"]`).first()
      await expect(renderedCover).toBeVisible()
      await expect(renderedCover).toHaveJSProperty('naturalWidth', 96)

      const refresh = page.waitForResponse(
        (result) =>
          result.url() === appUrl(`/api/v1/roms/${rom.id}/retry-artwork`) && result.request().method() === 'POST',
      )
      await page.getByRole('button', { name: 'Retry cover art' }).click()
      const refreshedResponse = await refresh
      expect(refreshedResponse.status()).toBe(200)
      const refreshed = await page.request.get(appUrl(`/api/v1/roms/${rom.id}`))
      const newArt = romSchema.parse(await refreshed.json())
      expect(newArt.gameBoxartFileIds).not.toBe(gameBoxartFileIds)
      const replacementId = z
        .string()
        .regex(/^metadata\//u)
        .parse(newArt.gameBoxartFileIds)
      const replacement = await page.request.get(appUrl(`/api/v1/files/${encodeURIComponent(replacementId)}`))
      expect(replacement.status()).toBe(200)
      expect(hash(await replacement.body())).toBe(hash(syntheticCover(2)))
      expect(providers).toEqual([
        'https://raw.githubusercontent.com',
        'https://thumbnails.libretro.com',
        'https://cdn.jsdelivr.net',
        'https://thumbnails.libretro.com',
        'https://cdn.jsdelivr.net',
        'https://thumbnails.libretro.com',
        'https://cdn.jsdelivr.net',
      ])
      expect(externalProviderRequests).toEqual([])

      const automatic = appUrl('/api/v1/mounted-library')
      const enable = await page.request.patch(automatic, { data: { automaticMetadata: true } })
      expect(enable.status(), await enable.text()).toBe(200)
      await page.reload()
      await expect(
        page.locator(`a img[src="${basePath}/api/v1/files/${encodeURIComponent(replacementId)}"]`),
      ).toBeVisible()
      expect(externalProviderRequests).toEqual([])

      const legacy = await page.request.post(appUrl(`/api/v1/roms/${rom.id}/identify`), {
        data: { name: 'Legacy Lantern' },
      })
      expect(legacy.status(), await legacy.text()).toBe(200)
      await page.reload()
      const legacyArt = page.locator('a img[src^="https://thumbnails.libretro.com/"][src*="/Named_Titles/"]')
      await expect(legacyArt).toBeVisible()
      expect(legacyArtworkRequests.some((pathname) => pathname.includes('/Named_Boxarts/'))).toBe(true)

      const disable = await page.request.patch(automatic, { data: { automaticMetadata: false } })
      expect(disable.status()).toBe(200)
      legacyArtworkRequests.length = 0
      await page.reload({ waitUntil: 'networkidle' })
      await expect(legacyArt).toHaveCount(0)
      expect(legacyArtworkRequests).toEqual([])

      const reenable = await page.request.patch(automatic, { data: { automaticMetadata: true } })
      expect(reenable.status()).toBe(200)
      const remove = await page.request.delete(appUrl(`/api/v1/roms/${rom.id}/boxart`))
      expect(remove.status()).toBe(200)
      await page.reload({ waitUntil: 'networkidle' })
      await expect(legacyArt).toHaveCount(0)
      expect(legacyArtworkRequests.some((pathname) => pathname.includes('/Named_Boxarts/'))).toBe(false)
      expect(hash(await readFile(fixtureFile))).toBe(initialHash)
      const final = await stat(fixtureFile)
      expect(final.mtimeMs).toBe(mtimeMs)
    } finally {
      const started = server
      if (started?.exitCode === null) {
        await new Promise<void>(function stop(resolve) {
          started.once('close', () => resolve())
          started.kill()
        })
      }
      if (logs) {
        await testInfo.attach('isolated-node-server', { body: logs, contentType: 'text/plain' })
      }
      await rm(root, { force: true, recursive: true })
    }
  })
}
