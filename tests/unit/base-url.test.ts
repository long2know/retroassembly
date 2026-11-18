import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getBasePath, normalizeBasePath, stripBasePath, withBasePath } from '#@/utils/isomorphic/base-url.ts'
import { getWebManifest } from '#@/utils/server/webmanifest.ts'

await describe('runtime application URLs', async () => {
  await it('defaults to root and normalizes single and nested deployment paths', () => {
    for (const value of [undefined, '', '/']) {
      assert.equal(normalizeBasePath(value), '/')
    }
    assert.equal(normalizeBasePath('/retroassembly/'), '/retroassembly')
    assert.equal(normalizeBasePath('/games/retroassembly/'), '/games/retroassembly')
    assert.equal(normalizeBasePath('/games/retro-assembly_2.0~preview'), '/games/retro-assembly_2.0~preview')
  })

  await it('rejects origins, ambiguous paths, encoded segments and traversal rather than silently using root', () => {
    for (const value of [
      'retroassembly',
      'https://arcade.example/retroassembly',
      '//arcade.example',
      '//',
      '/games//retroassembly',
      '/retroassembly//',
      '/games/./retroassembly',
      '/games/../retroassembly',
      '/games/%2e%2e/retroassembly',
      '/games%2fretroassembly',
      '/retroassembly?query=1',
      '/retroassembly#games',
      '/retro assembly',
      '/retroassembly\n',
      String.raw`/games\retroassembly`,
    ]) {
      assert.throws(() => normalizeBasePath(value), /BASE_URL/u, value)
    }
  })

  await it('preserves encoded paths, queries and fragments while respecting prefix boundaries', () => {
    const basePath = '/games/retroassembly'
    const file = '/api/v1/files/mounted%3AHomebrew%2FGame%20%231.nes?download=1#bytes'
    assert.equal(withBasePath(file, '/'), file)
    assert.equal(withBasePath(file, basePath), `${basePath}${file}`)
    assert.equal(withBasePath(stripBasePath(`${basePath}${file}`, basePath) || '/', basePath), `${basePath}${file}`)
    assert.equal(stripBasePath(`${basePath}${file}`, basePath), file)
    assert.equal(stripBasePath(`${basePath}?sort=name#games`, basePath), '/?sort=name#games')
    assert.equal(stripBasePath('/games/retroassembly2/library', basePath), undefined)
    assert.equal(stripBasePath('/library', basePath), undefined)
    assert.equal(withBasePath('/games/retroassembly2/library', basePath), `${basePath}/games/retroassembly2/library`)
    assert.equal(withBasePath('./assets/lazy-chunk.js', basePath), `${basePath}/assets/lazy-chunk.js`)
    assert.equal(withBasePath('/api/v1/files/game.nes', '/api'), '/api/api/v1/files/game.nes')
    assert.equal(withBasePath('./assets/lazy-chunk.js', '/assets'), '/assets/assets/lazy-chunk.js')
    assert.equal(withBasePath('/login', '/login'), '/login/login')
    assert.equal(withBasePath('/', basePath), `${basePath}/`)
    for (const value of [
      'https://cdn.example/core.wasm?x=1#core',
      '//cdn.example/image.png',
      'blob:fixture',
      '#games',
    ]) {
      assert.equal(withBasePath(value, basePath), value)
    }
  })

  await it('uses only runtime process configuration on the server and the public document path in browsers', (t) => {
    t.mock.property(process, 'env', { ...process.env, BASE_URL: '/server/path/' })
    assert.equal(getBasePath(), '/server/path')
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { documentElement: { dataset: { baseUrl: '/browser/path' } } },
    })
    try {
      assert.equal(getBasePath(), '/browser/path')
      assert.equal(withBasePath('/api/v1/preference'), '/browser/path/api/v1/preference')
    } finally {
      Reflect.deleteProperty(globalThis, 'document')
    }
  })

  await it('keeps installed app identity, navigation scope and icon URLs inside each deployment', () => {
    const origin = 'https://arcade.example'
    for (const basePath of ['/', '/retroassembly', '/games/retroassembly', '/assets', '/api']) {
      const prefix = basePath === '/' ? '' : basePath
      const manifestUrl = `${origin}${prefix}/manifest.webmanifest`
      const manifest = getWebManifest(basePath)
      assert.equal(new URL(manifest.id, origin).href, `${origin}${prefix}/?pwa_version=1`)
      assert.equal(new URL(manifest.scope, manifestUrl).href, `${origin}${prefix}/`)
      assert.equal(new URL(manifest.start_url, manifestUrl).href, `${origin}${prefix}/library`)
      for (const icon of manifest.icons) {
        assert.ok(new URL(icon.src, manifestUrl).pathname.startsWith(`${prefix}/assets/logo/`))
      }
    }
  })
})
