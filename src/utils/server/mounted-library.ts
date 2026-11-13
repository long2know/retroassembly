import { createHash } from 'node:crypto'
import path from 'node:path'
import { and, count, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import { getRunTimeEnv } from '#@/constants/env.ts'
import {
  getMountedFormat,
  resolveMountedPlatform,
  type MountedLibrarySettings,
  type MountedMetadataProgress,
  type MountedSource,
} from '#@/constants/mounted-library.ts'
import { platformMap, type PlatformName } from '#@/constants/platform.ts'
import { mountedLibrarySettingsTable, romTable, statusEnum } from '#@/databases/schema.ts'
import type { createDrizzle } from './drizzle.ts'
import {
  assertMountedRootAvailable,
  canonicalLocation,
  getMountedConfiguration,
  getMountedFileId,
  getMountedFileInfo,
  openMountedFile,
  isContainedPath,
  walkMountedFiles,
  type MountedConfiguration,
} from './mounted-files.ts'
import {
  getMountedLibrary,
  setMountedLibrary,
  type MountedBios,
  type MountedScanStatus,
  type MountedMetadataMatch,
} from './mounted-library-runtime.ts'

type Library = ReturnType<typeof createDrizzle>['library']
type ScanSnapshot = Omit<
  MountedScanStatus,
  'settings' | 'networkAllowed' | 'automaticMetadataEnabled' | 'platforms' | 'metadata'
>

interface MetadataJobOptions {
  automatic?: boolean
  platform?: PlatformName
  retryArtwork?: boolean
  retryErrors?: boolean
}

function visibleMountedCondition(platform?: PlatformName) {
  return and(
    eq(romTable.status, statusEnum.normal),
    isNull(romTable.userId),
    isNotNull(romTable.mountedSource),
    sql`json_extract(${romTable.mountedSource}, '$.available') = 1`,
    platform ? eq(romTable.platform, platform) : undefined,
  )
}

export function createMountedLibrary(library: Library, configuration: MountedConfiguration) {
  library
    .insert(mountedLibrarySettingsTable)
    .values({
      automaticMetadata: configuration.metadataEnabled,
      id: 1,
      scanIntervalSeconds: configuration.scanInterval,
      updatedAt: new Date(),
    })
    .onConflictDoNothing()
    .run()
  const persistedSettings = library
    .select()
    .from(mountedLibrarySettingsTable)
    .where(eq(mountedLibrarySettingsTable.id, 1))
    .get()
  if (!persistedSettings) {
    throw new Error('Mounted library settings could not be loaded')
  }
  let settings: MountedLibrarySettings = {
    automaticMetadata: persistedSettings.automaticMetadata,
    scanIntervalSeconds: persistedSettings.scanIntervalSeconds,
  }
  let metadata: MountedMetadataProgress = { errors: 0, processed: 0, running: false, total: 0 }
  let bioses: Partial<Record<PlatformName, MountedBios[]>> = {}
  let biosFiles = new Map<string, { path: string; revision: string }>()
  let scanning: Promise<MountedScanStatus> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let metadataTimer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let status: ScanSnapshot = {
    biosCount: 0,
    indexed: 0,
    running: false,
    unavailable: 0,
    unsupported: 0,
    warnings: [],
  }

  async function discoverBios(warnings: string[]) {
    const mapped: Partial<Record<PlatformName, MountedBios[]>> = {}
    const files = new Map<string, { path: string; revision: string }>()
    if (!configuration.bios) {
      return { files, mapped }
    }
    const requirements: { md5?: string; name: string; platform: PlatformName }[] = []
    for (const platform of Object.values(platformMap)) {
      const canonical = resolveMountedPlatform(platform.name)
      const names = canonical && canonical !== platform.name ? [platform.name, canonical] : [platform.name]
      for (const bios of platform.bioses || []) {
        for (const name of names) {
          requirements.push({ md5: bios.md5, name: bios.name, platform: name })
        }
      }
    }
    const names = new Set(requirements.map((bios) => bios.name.toLowerCase()))
    for await (const relative of walkMountedFiles(configuration.bios)) {
      const basename = path.posix.basename(relative).toLowerCase()
      if (!names.has(basename)) {
        continue
      }
      const { handle, revision, size } = await openMountedFile(configuration.bios, relative)
      let md5: string | undefined
      try {
        if (size === 0 || size > 32 * 1024 * 1024) {
          warnings.push(`BIOS ${relative}: empty or larger than the 32 MiB discovery limit`)
          continue
        }
        md5 = createHash('md5')
          .update(await handle.readFile())
          .digest('hex')
      } finally {
        await handle.close()
      }
      const fileId = getMountedFileId('bios', relative)
      for (const requirement of requirements.filter((bios) => bios.name.toLowerCase() === basename)) {
        if (requirement.md5 && requirement.md5 !== md5) {
          warnings.push(`BIOS ${relative}: checksum does not match ${requirement.name}; not selected`)
          continue
        }
        const platformBioses = mapped[requirement.platform] || []
        mapped[requirement.platform] = platformBioses
        if (!platformBioses.some((bios) => bios.fileName === requirement.name)) {
          platformBioses.push({ fileId, fileName: requirement.name, mounted: true })
          files.set(fileId, { path: relative, revision })
        }
      }
    }
    return { files, mapped }
  }

  async function performScan() {
    status = { ...status, error: undefined, lastScanStartedAt: new Date().toISOString(), running: true }
    try {
      const warnings: string[] = []
      const discovered = new Map<string, { fileName: string; platform: PlatformName; source: MountedSource }>()
      for await (const relative of walkMountedFiles(configuration.roms, '', true)) {
        const [system, ...segments] = relative.split('/')
        const platform = resolveMountedPlatform(system)
        if (!platform || segments.length === 0) {
          continue
        }
        const format = getMountedFormat(platform, path.posix.extname(relative))
        if (!format) {
          continue
        }
        const fileId = getMountedFileId('roms', relative)
        const { revision } = await getMountedFileInfo(configuration.roms, relative)
        discovered.set(fileId, {
          fileName: segments.join('/'),
          platform,
          source: {
            artwork: automaticMetadataEnabled() ? 'pending' : 'disabled',
            available: true,
            metadata: automaticMetadataEnabled() ? 'pending' : 'disabled',
            path: relative,
            revision,
            unsupportedReason: format.unsupportedReason,
          },
        })
      }
      const discoveredBios = await discoverBios(warnings)
      await assertMountedRootAvailable(configuration.roms)
      if (configuration.bios) {
        await assertMountedRootAvailable(configuration.bios)
      }
      const unavailable = library.transaction(function reconcile(transaction) {
        const existing = transaction
          .select({ fileId: romTable.fileId, id: romTable.id, mountedSource: romTable.mountedSource })
          .from(romTable)
          .where(and(isNull(romTable.userId), isNotNull(romTable.mountedSource)))
          .all()
        const existingByFileId = new Map(existing.map((rom) => [rom.fileId, rom]))
        for (const [fileId, item] of discovered) {
          const rom = existingByFileId.get(fileId)
          if (!rom) {
            transaction
              .insert(romTable)
              .values({
                fileId,
                fileName: item.fileName,
                mountedSource: item.source,
                platform: item.platform,
                userId: null,
              })
              .onConflictDoNothing()
              .run()
            continue
          }
          const previous = rom.mountedSource
          if (!previous) {
            continue
          }
          const replaced = previous.revision !== item.source.revision
          if (replaced || !previous.available) {
            const mountedSource =
              replaced && previous.metadata !== 'manual'
                ? item.source
                : {
                    ...previous,
                    available: true,
                    revision: item.source.revision,
                    ...(replaced ? { identification: undefined } : {}),
                  }
            transaction
              .update(romTable)
              .set({
                ...(replaced && previous.metadata !== 'manual'
                  ? {
                      gameBoxartFileIds: null,
                      gameDescription: null,
                      gameDeveloper: null,
                      gameGenres: null,
                      gameName: null,
                      gamePlayers: null,
                      gamePublisher: null,
                      gameRating: null,
                      gameReleaseDate: null,
                      gameReleaseYear: null,
                      gameThumbnailFileIds: null,
                      launchboxGameId: null,
                      libretroGameId: null,
                      rawGameMetadata: null,
                    }
                  : {}),
                mountedSource,
              })
              .where(eq(romTable.id, rom.id))
              .run()
          }
        }
        for (const rom of existing) {
          if (rom.mountedSource?.available && !discovered.has(rom.fileId)) {
            transaction
              .update(romTable)
              .set({ mountedSource: { ...rom.mountedSource, available: false } })
              .where(eq(romTable.id, rom.id))
              .run()
          }
        }
        return existing.filter((rom) => !discovered.has(rom.fileId)).length
      })
      bioses = discoveredBios.mapped
      biosFiles = discoveredBios.files
      const finishedAt = new Date().toISOString()
      status = {
        biosCount: biosFiles.size,
        indexed: discovered.size,
        lastScanFinishedAt: finishedAt,
        lastScanStartedAt: status.lastScanStartedAt,
        lastSuccessfulScanAt: finishedAt,
        running: false,
        unavailable,
        unsupported: [...discovered.values()].filter((item) => item.source.unsupportedReason).length,
        warnings: warnings.slice(0, 100),
      }
      console.info(
        `Mounted library: ${status.indexed} indexed, ${status.unavailable} unavailable, ${status.unsupported} unsupported, ${status.biosCount} BIOS files`,
      )
      for (const warning of status.warnings) {
        console.warn(`Mounted library: ${warning}`)
      }
      return getStatus()
    } catch (error) {
      status = {
        ...status,
        error: error instanceof Error ? error.message : String(error),
        lastScanFinishedAt: new Date().toISOString(),
        running: false,
      }
      console.error('Mounted library scan failed; existing rows were preserved:', error)
      throw error
    }
  }

  async function scan() {
    if (scanning) {
      return await scanning
    }
    scanning = performScan()
    try {
      return await scanning
    } finally {
      scanning = undefined
    }
  }

  async function readFile(id: string) {
    if (!/^mounted\/(?:roms|bios)\/[a-f0-9]{64}$/u.test(id)) {
      throw new HTTPException(400, { message: 'Invalid mounted file ID' })
    }
    const bios = biosFiles.get(id)
    let relative = bios?.path
    let revision = bios?.revision
    let root = bios ? configuration.bios : configuration.roms
    if (!bios) {
      const [rom] = await library
        .select()
        .from(romTable)
        .where(
          and(
            eq(romTable.fileId, id),
            eq(romTable.status, statusEnum.normal),
            isNull(romTable.userId),
            isNotNull(romTable.mountedSource),
          ),
        )
        .limit(1)
      if (!rom?.mountedSource?.available || getMountedFileId('roms', rom.mountedSource.path) !== id) {
        throw new HTTPException(404, { message: 'Mounted file not found' })
      }
      relative = rom.mountedSource.path
      revision = rom.mountedSource.revision
      root = configuration.roms
    }
    if (!root || !relative) {
      throw new HTTPException(404, { message: 'Mounted file not found' })
    }
    try {
      const file = await openMountedFile(root, relative)
      if (revision !== file.revision) {
        await file.handle.close()
        throw new HTTPException(409, { message: 'Mounted file changed; rescan the mounted library before loading' })
      }
      const reader = file.handle.readableWebStream({ autoClose: true }).getReader()
      return {
        body: new ReadableStream<Uint8Array>({
          async cancel(reason) {
            await reader.cancel(reason)
            reader.releaseLock()
          },
          async pull(controller) {
            const result = await reader.read()
            if (result.done) {
              reader.releaseLock()
              controller.close()
            } else {
              controller.enqueue(new Uint8Array(result.value))
            }
          },
        }),
        httpEtag: `"${file.revision}"`,
        size: file.size,
      }
    } catch (error) {
      if (error instanceof HTTPException) {
        throw error
      }
      throw new HTTPException(503, { cause: error, message: 'Mounted source unavailable or unsafe; rescan required' })
    }
  }

  function networkAllowed() {
    return (
      configuration.metadataEnabled && getRunTimeEnv().RETROASSEMBLY_RUN_TIME_SHARED_ROM_METADATA_ENABLED === 'true'
    )
  }

  function automaticMetadataEnabled() {
    return settings.automaticMetadata && networkAllowed()
  }

  function getStatus(): MountedScanStatus {
    const platforms = library
      .select({
        indexed: count(),
        platform: romTable.platform,
        unsupported: sql<number>`sum(CASE WHEN json_extract(${romTable.mountedSource}, '$.unsupportedReason') IS NOT NULL THEN 1 ELSE 0 END)`,
      })
      .from(romTable)
      .where(visibleMountedCondition())
      .groupBy(romTable.platform)
      .orderBy(romTable.platform)
      .all()
    const unavailable =
      library
        .select({ count: count() })
        .from(romTable)
        .where(
          and(
            eq(romTable.status, statusEnum.normal),
            isNull(romTable.userId),
            isNotNull(romTable.mountedSource),
            sql`json_extract(${romTable.mountedSource}, '$.available') = 0`,
          ),
        )
        .get()?.count || 0
    let indexed = 0
    let unsupported = 0
    for (const platform of platforms) {
      indexed += platform.indexed
      unsupported += platform.unsupported
    }
    return structuredClone({
      ...status,
      automaticMetadataEnabled: automaticMetadataEnabled(),
      indexed,
      metadata,
      networkAllowed: networkAllowed(),
      platforms,
      settings,
      unavailable,
      unsupported,
    })
  }

  function selectMetadataJob(operation: 'metadata' | 'artwork', options: MetadataJobOptions) {
    const automatic = options.automatic
      ? sql`(
          json_extract(${romTable.mountedSource}, '$.metadata') IN ('pending', 'disabled')
          OR (${options.retryErrors === false ? 0 : 1} = 1
            AND json_extract(${romTable.mountedSource}, '$.metadata') = 'error'
            AND coalesce(json_extract(${romTable.mountedSource}, '$.metadataAttemptedAt'), 0) < ${Date.now() - 300_000})
        )`
      : undefined
    const candidates = library
      .select({ id: romTable.id })
      .from(romTable)
      .where(
        and(
          visibleMountedCondition(options.platform),
          sql`json_extract(${romTable.mountedSource}, '$.metadata') != 'manual'`,
          automatic,
          operation === 'artwork' ? and(isNull(romTable.gameBoxartFileIds), isNotNull(romTable.gameName)) : undefined,
        ),
      )
      .orderBy(romTable.id)
      .all()
    metadata = {
      errors: 0,
      lastStartedAt: new Date().toISOString(),
      operation,
      processed: 0,
      running: true,
      total: candidates.length,
    }
    return candidates
  }

  async function runMetadataJob(
    operation: 'metadata' | 'artwork',
    options: MetadataJobOptions,
    candidates: { id: string }[],
  ) {
    try {
      const { enrichMountedRom, retryMountedArtwork } = await import('./mounted-metadata.ts')
      for (const candidate of candidates) {
        if (stopped || !networkAllowed() || (options.automatic && !automaticMetadataEnabled())) {
          break
        }
        const rom = library
          .select()
          .from(romTable)
          .where(and(eq(romTable.id, candidate.id), visibleMountedCondition(options.platform)))
          .get()
        if (!rom || rom.mountedSource?.metadata === 'manual') {
          metadata.processed += 1
          continue
        }
        try {
          const updated =
            operation === 'artwork'
              ? await retryMountedArtwork(library, rom)
              : await enrichMountedRom(library, rom, {
                  allowArtwork: options.automatic ? automaticMetadataEnabled : undefined,
                  retryArtwork: options.retryArtwork,
                  root: configuration.roms,
                })
          if (updated.mountedSource?.artwork === 'error') {
            metadata.errors += 1
          }
        } catch (error) {
          metadata.errors += 1
          metadata.error = error instanceof Error ? error.message : String(error)
        }
        metadata.processed += 1
        if (metadata.processed % 50 === 0 && metadata.processed < metadata.total) {
          await new Promise(function pause(resolve) {
            setTimeout(resolve, 1000)
          })
        }
      }
    } catch (error) {
      metadata.error = error instanceof Error ? error.message : String(error)
      console.error('Mounted metadata job failed:', error)
    } finally {
      metadata.running = false
      metadata.lastFinishedAt = new Date().toISOString()
    }
  }

  function startMetadataJob(operation: 'metadata' | 'artwork', options: MetadataJobOptions = {}) {
    if (!networkAllowed()) {
      throw new HTTPException(403, { message: 'Mounted metadata network access is disabled by server policy' })
    }
    if (metadata.running) {
      return getStatus()
    }
    clearTimeout(metadataTimer)
    const candidates = selectMetadataJob(operation, options)
    metadataTimer = setTimeout(async function explicitMetadata() {
      metadataTimer = undefined
      await runMetadataJob(operation, options, candidates)
    }, 0)
    metadataTimer.unref()
    return getStatus()
  }

  async function beginMetadata() {
    metadataTimer = undefined
    await enrichPending()
  }

  function scheduleEnrichment() {
    if (automaticMetadataEnabled() && !stopped && !metadata.running && !metadataTimer) {
      metadataTimer = setTimeout(beginMetadata, 0)
      metadataTimer.unref()
    }
  }

  async function enrichPending(retryErrors = true) {
    if (!automaticMetadataEnabled() || metadata.running || stopped) {
      return
    }
    const options: MetadataJobOptions = { automatic: true, retryErrors }
    const candidates = selectMetadataJob('metadata', options)
    await runMetadataJob('metadata', options, candidates)
  }

  function scheduleScan() {
    clearTimeout(timer)
    timer = undefined
    if (!stopped && settings.scanIntervalSeconds) {
      timer = setTimeout(tick, settings.scanIntervalSeconds * 1000)
      timer.unref()
    }
  }

  async function tick() {
    try {
      await scan()
      scheduleEnrichment()
    } catch {
      // A failed or partial traversal preserves the previous index and records the error.
    } finally {
      scheduleScan()
    }
  }

  function updateSettings(update: Partial<MountedLibrarySettings>) {
    const next = { ...settings, ...update }
    if (
      typeof next.automaticMetadata !== 'boolean' ||
      !Number.isSafeInteger(next.scanIntervalSeconds) ||
      next.scanIntervalSeconds < 0 ||
      next.scanIntervalSeconds > 86_400
    ) {
      throw new HTTPException(400, { message: 'Invalid mounted library settings' })
    }
    library
      .update(mountedLibrarySettingsTable)
      .set({ ...next, updatedAt: new Date() })
      .where(eq(mountedLibrarySettingsTable.id, 1))
      .run()
    settings = next
    scheduleScan()
    if (!settings.automaticMetadata && !metadata.running) {
      clearTimeout(metadataTimer)
      metadataTimer = undefined
    }
    scheduleEnrichment()
    return getStatus()
  }

  async function assertWritableDirectory(directory: string) {
    const canonical = await canonicalLocation(directory)
    for (const root of [configuration.roms, configuration.bios]) {
      if (root && (isContainedPath(root.directory, canonical) || isContainedPath(canonical, root.directory))) {
        throw new Error('Writable storage overlaps a mounted source')
      }
    }
  }

  return {
    assertWritableDirectory,
    configuration,
    enrichPending,
    getBioses(platform: PlatformName) {
      return structuredClone(bioses[platform] || [])
    },
    getStatus,
    async identify(rom: typeof romTable.$inferSelect, match: MountedMetadataMatch) {
      if (!networkAllowed()) {
        throw new HTTPException(403, { message: 'Mounted metadata network access is disabled by server policy' })
      }
      const { enrichMountedRom } = await import('./mounted-metadata.ts')
      return await enrichMountedRom(library, rom, {
        ...match,
        manual: true,
        retryArtwork: true,
        root: configuration.roms,
      })
    },
    readFile,
    refreshMetadata(options: { platform?: PlatformName; retryArtwork?: boolean } = {}) {
      return startMetadataJob('metadata', options)
    },
    retryArtwork(options: { platform?: PlatformName } = {}) {
      return startMetadataJob('artwork', options)
    },
    scan,
    scheduleEnrichment,
    start() {
      stopped = false
      scheduleEnrichment()
      scheduleScan()
    },
    stop() {
      stopped = true
      if (metadataTimer) {
        metadata.running = false
      }
      clearTimeout(timer)
      clearTimeout(metadataTimer)
      timer = undefined
      metadataTimer = undefined
    },
    updateSettings,
  }
}

export async function initializeMountedLibrary(library: Library) {
  const configuration = await getMountedConfiguration()
  if (!configuration) {
    setMountedLibrary(undefined)
    return
  }
  getMountedLibrary()?.stop()
  const instance = createMountedLibrary(library, configuration)
  setMountedLibrary(instance)
  await instance.scan()
  instance.start()
}
