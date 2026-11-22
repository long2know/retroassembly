import path from 'node:path'
import { defineConfig } from '@playwright/test'

export default defineConfig({
  outputDir: path.resolve('node_modules/.cache/mounted-metadata-repair-results'),
  reporter: 'line',
  testDir: '.',
  testMatch: /mounted-metadata-repair\.spec\.(?:mjs|ts)$/u,
  timeout: 75_000,
  use: {
    channel: process.env.RETROASSEMBLY_MOUNTED_TEST_BROWSER,
    headless: true,
    locale: 'en-US',
    viewport: { height: 820, width: 1200 },
  },
  workers: 1,
})
