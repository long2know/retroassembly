import { createHash } from 'node:crypto'
import path from 'node:path'
import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import { getMountedFormat, resolveMountedPlatform, type MountedSource } from '#@/constants/mounted-library.ts'
import { platformMap, type PlatformName } from '#@/constants/platform.ts'
import { romTable, statusEnum } from '#@/databases/schema.ts'
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

export function createMountedLibrary(library: Library, configuration: MountedConfiguration) {
  let bioses: Partial<Record<PlatformName, MountedBios[]>> = {}
  let biosFiles = new Map<string, { path: string; revision: string }>()
  let scanning: Promise<MountedScanStatus> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let metadataTimer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let enriching = false
  let status: MountedScanStatus = {
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
            available: true,
            metadata: configuration.metadataEnabled ? 'pending' : 'disabled',
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
                : { ...previous, available: true, revision: item.source.revision }
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
      return structuredClone(status)
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

  async function drainMetadata() {
    metadataTimer = undefined
    await enrichPending(false)
  }

  async function beginMetadata() {
    metadataTimer = undefined
    await enrichPending()
  }

  function scheduleEnrichment() {
    if (configuration.metadataEnabled && !stopped && !enriching && !metadataTimer) {
      metadataTimer = setTimeout(beginMetadata, 0)
      metadataTimer.unref()
    }
  }

  async function enrichPending(retryErrors = true) {
    if (!configuration.metadataEnabled || enriching || stopped) {
      return
    }
    enriching = true
    let more = false
    try {
      const { enrichMountedRoms } = await import('./mounted-metadata.ts')
      more = await enrichMountedRoms(library, retryErrors)
    } catch (error) {
      console.error('Mounted library metadata enrichment failed; retry with the metadata API:', error)
    } finally {
      enriching = false
      if (more && !stopped) {
        metadataTimer = setTimeout(drainMetadata, 1000)
        metadataTimer.unref()
      }
    }
  }

  async function tick() {
    try {
      await scan()
      scheduleEnrichment()
    } catch {
      // The scan records the failure and preserves the previous index.
    } finally {
      if (!stopped && configuration.scanInterval) {
        timer = setTimeout(tick, configuration.scanInterval * 1000)
        timer.unref()
      }
    }
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
    getStatus() {
      return structuredClone(status)
    },
    async identify(rom: typeof romTable.$inferSelect, match: MountedMetadataMatch) {
      const { enrichMountedRom } = await import('./mounted-metadata.ts')
      return await enrichMountedRom(library, rom, match)
    },
    readFile,
    scan,
    scheduleEnrichment,
    start() {
      stopped = false
      scheduleEnrichment()
      if (configuration.scanInterval && !timer) {
        timer = setTimeout(tick, configuration.scanInterval * 1000)
        timer.unref()
      }
    },
    stop() {
      stopped = true
      clearTimeout(timer)
      clearTimeout(metadataTimer)
      timer = undefined
      metadataTimer = undefined
    },
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
