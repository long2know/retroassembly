import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js'

const project = process.cwd()
const image = process.env.RETROASSEMBLY_MOUNTED_TEST_IMAGE || 'ghcr.io/long2know/retroassembly:latest'
const label = 'org.retro-web.project=5c9839ba'
const suffix = randomUUID().slice(0, 8)
const container = `retro-web-5c9839ba-app-${suffix}`
const initializer = `retro-web-5c9839ba-init-${suffix}`
const provider = `retro-web-5c9839ba-provider-${suffix}`
const network = `retro-web-5c9839ba-network-${suffix}`
const volume = `retro-web-5c9839ba-data-${suffix}`
const fixtureParent = path.resolve(project, 'tests/.mounted-library-fixtures')
await fs.mkdir(fixtureParent, { recursive: true })
const fixtures = await fs.mkdtemp(path.join(fixtureParent, 'docker-'))
const romRoot = path.join(fixtures, 'roms')
const biosRoot = path.join(fixtures, 'bios')
const romDirectory = path.join(romRoot, 'famicom', 'Homebrew')
const reportFile = path.resolve(
  process.env.RETROASSEMBLY_MOUNTED_TEST_REPORT || 'node_modules/.cache/mounted-library-acceptance.json',
)
const browserReportFile = path.join(fixtures, 'browser.json')
const report: Record<string, unknown> = { container, image, node: process.version, volume }
let volumeCreated = false
let networkCreated = false

function docker(...args: string[]) {
  return execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim()
}

function hash(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function chooseLoopbackPort() {
  const server = net.createServer()
  await new Promise<void>(function listen(resolve, reject) {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', function listening() {
      resolve()
    })
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const { port } = address
  await new Promise<void>(function close(resolve, reject) {
    server.close(function closed(error) {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
  return port
}

function attemptSourceWrites() {
  return docker(
    'exec',
    '--user',
    '1000:1000',
    container,
    'node',
    '-e',
    `const fs=require('node:fs');for(const root of ['/app/roms','/app/bios']) {
      try {fs.writeFileSync(root+'/must-not-exist','blocked');throw new Error('Source was writable')}
      catch(error) {if(error.code!=='EROFS')throw error;console.log(root+': '+error.code)}
    }`,
  )
}

function createHomebrew() {
  const header = Buffer.from([0x4e, 0x45, 0x53, 0x1a, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  const prg = Buffer.alloc(16 * 1024, 0xea)
  // Original NROM program: cycle the universal background palette once per vblank.
  const program = [
    0x78, 0xd8, 0xa2, 0xff, 0x9a, 0xe8, 0x8e, 0x00, 0x20, 0x8e, 0x01, 0x20, 0x86, 0x00, 0x2c, 0x02, 0x20, 0x10, 0xfb,
    0xa9, 0x3f, 0x8d, 0x06, 0x20, 0xa9, 0x00, 0x8d, 0x06, 0x20, 0xa5, 0x00, 0x29, 0x3f, 0x8d, 0x07, 0x20, 0xe6, 0x00,
    0xa9, 0x00, 0x8d, 0x06, 0x20, 0x8d, 0x06, 0x20, 0x2c, 0x02, 0x20, 0x30, 0xfb, 0x4c, 0x0e, 0x80,
  ]
  prg.set(program)
  for (const vector of [0x3f_fa, 0x3f_fc, 0x3f_fe]) {
    prg.writeUInt16LE(0x80_00, vector)
  }
  return Buffer.concat([header, prg, Buffer.alloc(8 * 1024)])
}

async function snapshot(directory: string) {
  const entries: Record<string, unknown>[] = []
  async function visit(relative: string) {
    const absolute = path.join(directory, relative)
    const stat = await fs.lstat(absolute)
    const entry: Record<string, unknown> = {
      mode: stat.mode,
      mtime: stat.mtimeMs,
      name: relative,
      size: stat.size,
    }
    if (stat.isFile()) {
      entry.sha256 = hash(await fs.readFile(absolute))
    } else if (stat.isSymbolicLink()) {
      entry.link = await fs.readlink(absolute)
    }
    entries.push(entry)
    if (stat.isDirectory()) {
      const names = await fs.readdir(absolute)
      for (const name of names.toSorted()) {
        await visit(path.join(relative, name))
      }
    }
  }
  await visit('')
  return entries
}

async function waitReady(url: string) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (response.ok) {
        return
      }
    } catch {}
    await new Promise(function wait(resolve) {
      setTimeout(resolve, 500)
    })
  }
  throw new Error('Isolated production server did not become ready')
}

try {
  await fs.mkdir(romDirectory, { recursive: true })
  await fs.mkdir(biosRoot)
  await fs.mkdir(path.join(fixtures, 'provider-data'))
  for (const directory of [fixtures, romRoot, path.dirname(romDirectory), romDirectory, biosRoot]) {
    await fs.chmod(directory, 0o777)
  }
  const rom = createHomebrew()
  const zipContent = Buffer.from(rom)
  zipContent[zipContent.length - 1] = 1
  const romMd5 = createHash('md5').update(rom).digest('hex')
  const zipMd5 = createHash('md5').update(zipContent).digest('hex')
  const zipWriter = new ZipWriter(new Uint8ArrayWriter())
  await zipWriter.add('Inner Payload.nes', new Uint8ArrayReader(zipContent), { level: 0 })
  const zipArchive = await zipWriter.close()
  report.fixtureHashes = { romMd5, zipArchive: hash(zipArchive), zipMd5 }
  const bios = Buffer.from(Array.from({ length: 192 }, (_, index) => (index * 37) % 256))
  const romFile = path.join(romDirectory, 'Immutable Pulse.nes')
  await fs.writeFile(romFile, rom, { mode: 0o666 })
  await fs.writeFile(path.join(romDirectory, 'GoodTools Alias (U) [!].zip'), zipArchive, { mode: 0o666 })
  await fs.writeFile(path.join(biosRoot, 'nes.pal'), bios, { mode: 0o666 })
  await fs.writeFile(path.join(fixtures, 'outside.nes'), rom)
  await fs.symlink(path.join(fixtures, 'outside.nes'), path.join(romDirectory, 'escape.nes'))
  await fs.writeFile(path.join(romDirectory, 'ignored.txt'), 'Not a supported game\n')
  const before = { bios: await snapshot(biosRoot), roms: await snapshot(romRoot) }
  report.sourceBefore = before
  report.imageId = docker('image', 'inspect', image, '--format', '{{.Id}}')
  docker('volume', 'create', '--label', label, volume)
  volumeCreated = true
  const port = await chooseLoopbackPort()
  docker(
    'run',
    '--rm',
    '--name',
    initializer,
    '--label',
    label,
    '--network',
    'none',
    '--user',
    '0:0',
    '--mount',
    `type=volume,src=${volume},dst=/app/data`,
    '--entrypoint',
    'node',
    image,
    '-e',
    "require('node:fs').chownSync('/app/data',1000,1000)",
  )
  docker('network', 'create', '--label', label, network)
  networkCreated = true
  const providerMetadata = [
    {
      launchbox: {
        databaseId: 1,
        developer: 'Original fixture author',
        name: 'Immutable Pulse — provider metadata',
        overview: 'Controlled provider response for the original synthetic homebrew',
      },
      libretro: {
        id: 'immutable-pulse-fixture',
        md5: romMd5,
        name: 'Immutable Pulse (Original Synthetic Fixture)',
      },
    },
    {
      launchbox: {
        databaseId: 2,
        name: 'Archive Pulse — content metadata',
        overview: 'Matched the original NES payload, not its unrelated GoodTools ZIP filename',
      },
      libretro: { id: 'archive-pulse-fixture', md5: zipMd5, name: 'Archive Pulse (Original Synthetic Fixture)' },
    },
  ]
  docker(
    'run',
    '-d',
    '--name',
    provider,
    '--label',
    label,
    '--network',
    network,
    '--user',
    '1000:1000',
    '--read-only',
    '--mount',
    `type=bind,src=${path.join(fixtures, 'provider-data')},dst=/app/data,readonly`,
    '--entrypoint',
    'node',
    image,
    '-e',
    `require('node:http').createServer((request,response)=>{
      if(request.url==='/'){response.writeHead(200);response.end('ready');return}
      let body='';
      request.on('data',chunk=>{body+=chunk});
      request.on('end',()=>{
        const input=JSON.parse(body),file=input.files?.[0];
        const expected=${JSON.stringify([romMd5, zipMd5])};
        const records=${JSON.stringify(providerMetadata)};
        const index=expected.indexOf(file?.md5);
        console.log(JSON.stringify({method:request.method,url:request.url,input,matched:index>=0}));
        response.writeHead(200,{'Content-Type':'application/json'});
        response.end(JSON.stringify(index>=0?[records[index]]:[]));
      });
    }).listen(8001,'0.0.0.0');`,
  )
  docker(
    'exec',
    provider,
    'node',
    '-e',
    `(async()=>{for(let i=0;i<30;i++){
      try {if((await fetch('http://127.0.0.1:8001/')).ok)return}
      catch{}
      await new Promise(resolve=>setTimeout(resolve,100));
    }throw new Error('Fixture provider did not become ready')})()`,
  )
  docker(
    'run',
    '-d',
    '--name',
    container,
    '--label',
    label,
    '--user',
    '1000:1000',
    '--network',
    network,
    '--publish',
    `127.0.0.1:${port}:8000`,
    '--mount',
    `type=volume,src=${volume},dst=/app/data`,
    '--mount',
    `type=bind,src=${romRoot},dst=/app/roms${process.env.RETROASSEMBLY_MOUNTED_TEST_MUTATION === 'rw-rom-bind' ? '' : ',readonly'}`,
    '--mount',
    `type=bind,src=${biosRoot},dst=/app/bios,readonly`,
    '--env',
    'PUID=1000',
    '--env',
    'PGID=1000',
    '--env',
    'RETROASSEMBLY_RUN_TIME_DATA_DIRECTORY=/app/data',
    '--env',
    'RETROASSEMBLY_RUN_TIME_STORAGE_DIRECTORY=/app/data/storage',
    '--env',
    'RETROASSEMBLY_RUN_TIME_ENABLE_SHARED_ROM_LIBRARY=true',
    '--env',
    'RETROASSEMBLY_RUN_TIME_SHARED_LIBRARY_ONLY=true',
    '--env',
    'RETROASSEMBLY_RUN_TIME_SHARED_ROM_DIRECTORY=/app/roms',
    '--env',
    'RETROASSEMBLY_RUN_TIME_SHARED_BIOS_DIRECTORY=/app/bios',
    '--env',
    'RETROASSEMBLY_RUN_TIME_SHARED_ROM_SCAN_INTERVAL=0',
    '--env',
    'RETROASSEMBLY_RUN_TIME_SHARED_ROM_METADATA_ENABLED=true',
    '--env',
    `RETROASSEMBLY_RUN_TIME_MSLEUTH_HOST=http://${provider}:8001/`,
    '--env',
    'RETROASSEMBLY_RUN_TIME_MSLEUTH_FALLBACK_HOST=',
    image,
  )
  const inspect = JSON.parse(docker('inspect', container))[0]
  report.mounts = inspect.Mounts
  report.user = inspect.Config.User
  assert.equal(inspect.Config.User, '1000:1000')
  assert.equal(inspect.Mounts.find((mount: { Destination: string }) => mount.Destination === '/app/data')?.RW, true)
  for (const destination of ['/app/roms', '/app/bios']) {
    assert.equal(
      inspect.Mounts.find((mount: { Destination: string }) => mount.Destination === destination)?.RW,
      false,
      `${destination} must be a Docker read-only mount`,
    )
  }
  const binding = inspect.NetworkSettings.Ports['8000/tcp'][0]
  assert.equal(binding.HostIp, '127.0.0.1')
  assert.notEqual(binding.HostPort, '8910')
  assert.notEqual(binding.HostPort, '8000')
  const url = `http://127.0.0.1:${binding.HostPort}`
  report.url = url
  await waitReady(`${url}/login`)
  report.writeAttemptsBeforePlay = attemptSourceWrites()
  const result = spawnSync(
    process.execPath,
    [
      path.join(project, 'node_modules/@playwright/test/cli.js'),
      'test',
      '-c',
      'tests/e2e/mounted-library.config.ts',
      '--tsconfig',
      'tests/e2e/tsconfig.playwright.json',
    ],
    {
      env: {
        ...process.env,
        RETROASSEMBLY_MOUNTED_TEST_BIOS_SHA256: hash(bios),
        RETROASSEMBLY_MOUNTED_TEST_BROWSER_REPORT: browserReportFile,
        RETROASSEMBLY_MOUNTED_TEST_CONTAINER: container,
        RETROASSEMBLY_MOUNTED_TEST_PROVIDER: provider,
        RETROASSEMBLY_MOUNTED_TEST_ROM_SHA256: hash(rom),
        RETROASSEMBLY_MOUNTED_TEST_ZIP_CONTENT_MD5: zipMd5,
        RETROASSEMBLY_MOUNTED_TEST_ZIP_SHA256: hash(zipArchive),
        RETROASSEMBLY_MOUNTED_TEST_URL: url,
      },
      stdio: 'inherit',
    },
  )
  assert.equal(result.status, 0, 'Production browser/API acceptance failed')
  report.browser = JSON.parse(await fs.readFile(browserReportFile, 'utf8'))
  report.writeAttemptsAfterRestarts = attemptSourceWrites()
  const after = { bios: await snapshot(biosRoot), roms: await snapshot(romRoot) }
  report.sourceAfter = after
  assert.deepEqual(after, before, 'Mounted source names, bytes, modes, or mtimes changed')
  report.serverProcesses = docker('top', container, '-eo', 'pid,comm,args')
  report.providerLogs = docker('logs', provider)
  report.passed = true
} catch (error) {
  report.passed = false
  report.error = error instanceof Error ? error.message : String(error)
  throw error
} finally {
  const cleanupErrors: string[] = []
  for (const name of [container, initializer, provider]) {
    try {
      const result = spawnSync('docker', ['inspect', name], { encoding: 'utf8' })
      if (result.status === 0) {
        const [inspect] = JSON.parse(result.stdout)
        assert.equal(inspect.Config.Labels['org.retro-web.project'], '5c9839ba')
        const logs = spawnSync('docker', ['logs', name], { encoding: 'utf8' })
        report[`${name}Logs`] = `${logs.stdout || ''}${logs.stderr || ''}`
        docker('rm', '-f', '-v', name)
      }
    } catch (error) {
      cleanupErrors.push(String(error))
    }
  }
  for (const [created, resource, name] of [
    [volumeCreated, 'volume', volume],
    [networkCreated, 'network', network],
  ] as const) {
    if (created) {
      try {
        docker(resource, 'rm', name)
      } catch (error) {
        cleanupErrors.push(String(error))
      }
    }
  }
  if (report.sourceBefore && !report.sourceAfter) {
    try {
      report.sourceAfter = { bios: await snapshot(biosRoot), roms: await snapshot(romRoot) }
      assert.deepEqual(report.sourceAfter, report.sourceBefore, 'Mounted sources changed during a failed test')
    } catch (error) {
      cleanupErrors.push(String(error))
    }
  }
  if (cleanupErrors.length) {
    report.cleanupErrors = cleanupErrors
    report.passed = false
  }
  await fs.mkdir(path.dirname(reportFile), { recursive: true })
  await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`)
  await fs.rm(fixtures, { force: true, recursive: true })
  console.info(`Acceptance report: ${reportFile}`)
  assert.equal(cleanupErrors.length, 0, 'An exact project-owned acceptance resource could not be removed')
}
