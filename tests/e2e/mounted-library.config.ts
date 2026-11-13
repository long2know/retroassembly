import { defineConfig } from '@playwright/test'

export default defineConfig({
  outputDir: '../../node_modules/.cache/mounted-library-results',
  reporter: 'line',
  retries: 0,
  testDir: '.',
  testMatch: 'mounted-library.spec.ts',
  timeout: 240_000,
  use: {
    baseURL: process.env.RETROASSEMBLY_MOUNTED_TEST_URL,
    channel: process.env.RETROASSEMBLY_MOUNTED_TEST_BROWSER || 'chrome',
    headless: true,
    launchOptions: {
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
  },
  workers: 1,
})
