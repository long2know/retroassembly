import { createHash } from 'node:crypto'
import path from 'node:path'
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { DateTime } from 'luxon'
import { createClient, type IdentifyParameter, type QueryParameter } from 'msleuth/client'
import { z } from 'zod'
import { getDirectories, getRunTimeEnv } from '#@/constants/env.ts'
import {
  getMountedManualMetadataFields,
  type MountedArtworkOutcome,
  type MountedIdentification,
  type MountedSource,
} from '#@/constants/mounted-library.ts'
import { platformMap, type PlatformName } from '#@/constants/platform.ts'
import { romTable, statusEnum } from '#@/databases/schema.ts'
import { getPinnedLibretroThumbnailUrl, libretroThumbnailsHost } from '#@/utils/isomorphic/cdn.ts'
import type { createDrizzle } from './drizzle.ts'
import type { getMountedCatalogEntry } from './mounted-catalog.ts'
import type { MountedRoot } from './mounted-files.ts'
import { getMountedIdentification } from './mounted-identification.ts'
import { MountedRepairError } from './mounted-library-runtime.ts'
import { assertMountedMetadataNetworkAllowed, readMountedProviderBytes } from './mounted-provider.ts'
import { createFilesystemStorage } from './storage.ts'

type Library = ReturnType<typeof createDrizzle>['library']
type MountedRom = typeof romTable.$inferSelect

interface EnrichmentOptions {
  allowArtwork?: () => boolean
  launchboxId?: number
  libretroId?: string
  manual?: boolean
  name?: string
  retryArtwork?: boolean
  root?: MountedRoot
}

interface ArtworkOptions {
  allowArtwork?: () => boolean
  refreshArtwork?: boolean
  retryArtwork?: boolean
}

const nullableString = z.string().nullish()
const nullableNumber = z.union([z.number(), z.string()]).nullish()
const metadataSchema = z.object({
  launchbox: z
    .looseObject({
      databaseId: z.number().nullish(),
      developer: nullableString,
      genres: nullableString,
      maxPlayers: nullableNumber,
      name: nullableString,
      overview: nullableString,
      publisher: nullableString,
      releaseDate: nullableString,
      releaseYear: nullableNumber,
    })
    .nullish(),
  libretro: z
    .looseObject({
      developer: nullableString,
      genres: nullableString,
      id: nullableString,
      md5: nullableString,
      name: nullableString,
      publisher: nullableString,
      releaseyear: nullableNumber,
      users: nullableNumber,
    })
    .nullish(),
})

class NoProviderMatchError extends Error {
  override name = 'NoProviderMatchError'
}

type ProviderMetadata = z.infer<typeof metadataSchema>
type CatalogEntry = Awaited<ReturnType<typeof getMountedCatalogEntry>>

async function requestMetadata(parameter: { identify: IdentifyParameter } | { query: QueryParameter }) {
  assertMountedMetadataNetworkAllowed()
  const env = getRunTimeEnv()
  const hosts = [
    env.RETROASSEMBLY_RUN_TIME_MSLEUTH_HOST,
    ...env.RETROASSEMBLY_RUN_TIME_MSLEUTH_FALLBACK_HOST.split(','),
  ].filter(Boolean)
  const signal = AbortSignal.timeout(15_000)
  let lastError: unknown = new Error('No metadata provider is configured')
  for (const host of hosts) {
    try {
      const client = createClient(host, {
        async fetch(input, init) {
          assertMountedMetadataNetworkAllowed()
          const response = await fetch(input, { ...init, redirect: 'error', signal })
          if (!response.ok) {
            await response.body?.cancel()
            throw new Error(`Metadata provider returned HTTP ${response.status}`)
          }
          return response
        },
      })
      return 'identify' in parameter ? await client.identify(parameter.identify) : await client.query(parameter.query)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

function coverFilename(name: string) {
  return `${name.replaceAll(/[&*/:`<>?\\|"]/gu, '_')}.png`
}

export function getMountedCoverUrl(platform: PlatformName, name: string) {
  return new URL(
    [platformMap[platform].libretroName, 'Named_Boxarts', coverFilename(name)]
      .map((segment) => encodeURIComponent(segment))
      .join('/'),
    libretroThumbnailsHost,
  )
}

function getImageExtension(mimeType: string, bytes: Buffer) {
  if (mimeType === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return 'png'
  }
  if (mimeType === 'image/jpeg' && bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) {
    return 'jpg'
  }
  if (
    mimeType === 'image/webp' &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp'
  }
  throw new Error('Cover provider image does not match its declared image type')
}

export async function cacheMountedCover(rom: MountedRom, name: string) {
  if (!rom.mountedSource) {
    throw new Error('Not a mounted ROM')
  }
  const url = getMountedCoverUrl(rom.platform, name)
  const mirror = getPinnedLibretroThumbnailUrl(platformMap[rom.platform].libretroName, coverFilename(name))
  const signal = AbortSignal.timeout(10_000)
  for (const provider of mirror ? [url, mirror] : [url]) {
    assertMountedMetadataNetworkAllowed()
    const response = await fetch(provider, { redirect: 'error', signal })
    if (response.status === 404) {
      await response.body?.cancel()
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Cover provider returned HTTP ${response.status}`)
    }
    const mimeType = response.headers.get('Content-Type')?.split(';')[0]
    if (!mimeType || !['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) {
      await response.body?.cancel()
      throw new Error('Cover provider returned an unsupported image type')
    }
    const bytes = await readMountedProviderBytes(response, 10 * 1024 * 1024, 'Cover provider image')
    const extension = getImageExtension(mimeType, bytes)
    const coverKey = createHash('sha256').update(url.href).update(bytes).digest('hex').slice(0, 24)
    const id = `metadata/${rom.id}/${rom.mountedSource.revision}-${coverKey}.${extension}`
    const { storageDirectory } = getDirectories()
    const storage = createFilesystemStorage(storageDirectory)
    if (!(await storage.head(id))) {
      await storage.put(id, new Blob([bytes], { type: mimeType }))
    }
    return id
  }
}

function uniqueNames(...names: (string | null | undefined)[]) {
  return [...new Set(names.filter((name): name is string => Boolean(name?.trim())))]
}

function providerCoverNames(metadata: ProviderMetadata, title: string | null) {
  return uniqueNames(metadata.libretro?.name, metadata.launchbox?.name, title)
}

function currentCoverNames(rom: MountedRom) {
  const source = rom.mountedSource
  if (source?.catalogMatch) {
    return uniqueNames(source.catalogMatch.name, source.catalogMatch.shortName)
  }
  if (source && getMountedManualMetadataFields(source).includes('gameName')) {
    return uniqueNames(rom.gameName)
  }
  const stored = metadataSchema.safeParse(rom.rawGameMetadata || {})
  return providerCoverNames(stored.data || {}, rom.gameName)
}

function getArtworkTarget(rom: MountedRom, name?: string) {
  return name ? createHash('sha256').update(getMountedCoverUrl(rom.platform, name).href).digest('hex') : undefined
}

function hasManualArtwork(rom: MountedRom) {
  return (
    rom.mountedSource?.artwork === 'manual' ||
    rom.gameBoxartFileIds?.split(',').some((id) => !id.startsWith('metadata/'))
  )
}

async function resolveArtwork(rom: MountedRom, names: string[], options: ArtworkOptions) {
  const source = rom.mountedSource
  if (!source) {
    throw new Error('Not a mounted ROM')
  }
  const current = {
    artwork: source.artwork || 'pending',
    artworkAttemptedAt: source.artworkAttemptedAt,
    artworkError: source.artworkError,
    artworkTarget: source.artworkTarget,
    gameBoxartFileIds: rom.gameBoxartFileIds,
  }
  if (hasManualArtwork(rom)) {
    return {
      ...current,
      artwork: 'manual' as const,
      artworkError: undefined,
    }
  }
  const target = getArtworkTarget(rom, names[0])
  const previousTarget = source.artworkTarget || getArtworkTarget(rom, currentCoverNames(rom)[0])
  const changed = target !== previousTarget
  const artworkFailed = source.artwork === 'missing' || source.artwork === 'error'
  if (!changed && rom.gameBoxartFileIds && !options.refreshArtwork) {
    return { ...current, artwork: artworkFailed ? current.artwork : ('ready' as const), artworkTarget: target }
  }
  if ((!changed && !options.retryArtwork && artworkFailed) || options.allowArtwork?.() === false) {
    return changed
      ? { artwork: 'pending' as const, artworkTarget: target, gameBoxartFileIds: null }
      : { ...current, artworkTarget: target }
  }
  const attempt = {
    artworkAttemptedAt: Date.now(),
    artworkTarget: target,
    gameBoxartFileIds: changed ? null : rom.gameBoxartFileIds,
  }
  try {
    for (const name of names) {
      const id = await cacheMountedCover(rom, name)
      if (id) {
        return { ...attempt, artwork: 'ready' as const, gameBoxartFileIds: id }
      }
    }
    return { ...attempt, artwork: 'missing' as const }
  } catch (error) {
    if (error instanceof MountedRepairError) {
      throw error
    }
    const artworkError = error instanceof Error ? error.message : String(error)
    console.warn(`Mounted artwork request failed: ${artworkError}`)
    return { ...attempt, artwork: 'error' as const, artworkError }
  }
}

async function updateMountedMetadata(library: Library, rom: MountedRom, values: Partial<typeof romTable.$inferInsert>) {
  const source = rom.mountedSource
  if (!source) {
    throw new MountedRepairError('source-unavailable')
  }
  const [updated] = await library
    .update(romTable)
    .set(values)
    .where(
      and(
        eq(romTable.id, rom.id),
        eq(romTable.status, statusEnum.normal),
        isNull(romTable.userId),
        eq(romTable.mountedSource, source),
        eq(romTable.updatedAt, rom.updatedAt),
      ),
    )
    .returning()
  if (!updated) {
    throw new MountedRepairError('metadata-stale')
  }
  return updated
}

async function findProviderMatch(
  platform: PlatformName,
  identification: MountedIdentification,
  match?: EnrichmentOptions,
) {
  if (match?.launchboxId || match?.libretroId) {
    const results = await requestMetadata({
      query: { conditions: [{ launchboxId: match.launchboxId, libretroId: match.libretroId }] },
    })
    const result = results?.[0]
    return result && metadataSchema.parse(result)
  }

  const payload =
    identification.mode === 'zip-entry' && identification.payloadName
      ? path.posix.basename(identification.payloadName)
      : undefined
  const names = match ? [match.name || identification.name] : uniqueNames(payload, identification.name)
  for (const [index, name] of names.entries()) {
    const results = await requestMetadata({
      identify: { files: [{ md5: !match && index === 0 ? identification.md5 : undefined, name }], platform },
    })
    const result = results?.[0]
    if (result) {
      const metadata = metadataSchema.parse(result)
      if (metadata.launchbox?.name || metadata.libretro?.name) {
        return metadata
      }
    }
  }
}

export async function enrichMountedRom(library: Library, rom: MountedRom, options: EnrichmentOptions = {}) {
  if (!rom.mountedSource?.available) {
    throw new Error('Mounted source is unavailable')
  }
  assertMountedMetadataNetworkAllowed()
  const match = options.manual || options.launchboxId || options.libretroId || options.name ? options : undefined
  if (rom.mountedSource.metadata === 'manual' && !match) {
    return rom
  }
  let source: MountedSource = rom.mountedSource
  let current = rom
  try {
    const identification = await getMountedIdentification(rom, options.root)
    if (source.identification !== identification) {
      const nextSource = { ...source, identification }
      current = await updateMountedMetadata(library, current, { mountedSource: nextSource })
      source = nextSource
    }
    if (identification.mode === 'ambiguous' && !match) {
      throw new Error(identification.error || 'Ambiguous ZIP requires an explicit manual metadata match')
    }
    const metadata = (await findProviderMatch(rom.platform, identification, match)) || {}
    const { launchbox, libretro } = metadata
    const gameName = launchbox?.name || libretro?.name
    if (!gameName) {
      throw new NoProviderMatchError(
        'No provider match was found; edit the app metadata or retry with a different name',
      )
    }
    const { gameBoxartFileIds, ...artwork } = await resolveArtwork(
      current,
      providerCoverNames(metadata, gameName),
      options,
    )
    const date = launchbox?.releaseDate ? DateTime.fromISO(launchbox.releaseDate) : undefined
    const year = Number(launchbox?.releaseYear || libretro?.releaseyear)
    const players = Number(launchbox?.maxPlayers || libretro?.users)
    return await updateMountedMetadata(library, current, {
      gameBoxartFileIds,
      gameDescription: launchbox?.overview ?? null,
      gameDeveloper: launchbox?.developer || libretro?.developer || null,
      gameGenres: (launchbox?.genres || libretro?.genres)?.replaceAll(';', ',') ?? null,
      gameName,
      gamePlayers: Number.isSafeInteger(players) && players > 0 ? players : null,
      gamePublisher: launchbox?.publisher || libretro?.publisher || null,
      gameReleaseDate: date?.isValid ? date.toJSDate() : null,
      gameReleaseYear: Number.isSafeInteger(year) && year > 0 ? year : null,
      launchboxGameId: launchbox?.databaseId ?? null,
      libretroGameId: libretro?.id ?? null,
      mountedSource: {
        ...source,
        artworkError: undefined,
        ...artwork,
        catalogMatch: undefined,
        identification: {
          ...identification,
          confidence:
            !match && identification.md5 && libretro?.md5?.toLowerCase() === identification.md5
              ? 'content'
              : 'filename',
        },
        manualMetadataFields: match ? [] : undefined,
        metadata: match ? 'manual' : 'ready',
        metadataAttemptedAt: Date.now(),
        metadataError: undefined,
        metadataOutcome: 'matched',
      },
      rawGameMetadata: { launchbox, libretro },
    })
  } catch (error) {
    if (error instanceof MountedRepairError) {
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    await updateMountedMetadata(library, current, {
      mountedSource: {
        ...source,
        metadata: source.metadata === 'manual' ? 'manual' : 'error',
        metadataAttemptedAt: Date.now(),
        metadataError: message,
        metadataOutcome: error instanceof NoProviderMatchError ? 'no-match' : 'error',
      },
    })
    if (!(error instanceof NoProviderMatchError)) {
      console.warn(`Mounted metadata request failed: ${message}`)
    }
    throw error
  }
}

export async function selectMountedCatalogMatch(
  library: Library,
  rom: MountedRom,
  { assertCurrent, entry }: { assertCurrent: () => Promise<void>; entry: CatalogEntry },
) {
  const source = rom.mountedSource
  if (!source?.available) {
    throw new MountedRepairError('source-unavailable')
  }
  const { candidate } = entry
  const manualFields = new Set(getMountedManualMetadataFields(source))
  const { gameBoxartFileIds, ...artwork } = await resolveArtwork(rom, entry.coverNames, { retryArtwork: true })
  await assertCurrent()
  await updateMountedMetadata(library, rom, {
    gameBoxartFileIds,
    gameDescription: manualFields.has('gameDescription') ? undefined : null,
    gameDeveloper: manualFields.has('gameDeveloper') ? undefined : (entry.developer ?? null),
    gameGenres: manualFields.has('gameGenres') ? undefined : (entry.genres ?? null),
    gameName: candidate.name,
    gamePlayers: manualFields.has('gamePlayers') ? undefined : (entry.players ?? null),
    gamePublisher: manualFields.has('gamePublisher') ? undefined : (entry.publisher ?? null),
    gameRating: null,
    gameReleaseDate: manualFields.has('gameReleaseDate') ? undefined : null,
    gameReleaseYear: manualFields.has('gameReleaseDate') ? null : (candidate.year ?? null),
    launchboxGameId: null,
    libretroGameId: null,
    mountedSource: {
      ...source,
      artworkError: undefined,
      ...artwork,
      catalogMatch: { id: candidate.id, name: candidate.name, shortName: candidate.shortName },
      identification: source.identification ? { ...source.identification, confidence: undefined } : undefined,
      manualMetadataFields: [...manualFields].filter((field) => field !== 'gameName'),
      metadata: 'manual',
      metadataAttemptedAt: Date.now(),
      metadataError: undefined,
      metadataOutcome: 'matched',
    },
    rawGameMetadata: null,
  })
  return { artwork: reportedArtwork(artwork.artwork) }
}

function reportedArtwork(artwork?: MountedSource['artwork']): MountedArtworkOutcome {
  if (artwork === 'ready' || artwork === 'error' || artwork === 'manual' || artwork === 'missing') {
    return artwork
  }
  return 'no-title'
}

export async function retryMountedArtwork(library: Library, rom: MountedRom, assertCurrent?: () => Promise<void>) {
  const source = rom.mountedSource
  if (!source?.available) {
    throw new MountedRepairError('source-unavailable')
  }
  assertMountedMetadataNetworkAllowed()
  if (hasManualArtwork(rom)) {
    return { artwork: 'manual' as const }
  }
  const names = currentCoverNames(rom)
  if (!names.length) {
    return { artwork: 'no-title' as const }
  }
  const { gameBoxartFileIds, ...artwork } = await resolveArtwork(rom, names, {
    refreshArtwork: Boolean(assertCurrent),
    retryArtwork: true,
  })
  await assertCurrent?.()
  await updateMountedMetadata(library, rom, {
    gameBoxartFileIds,
    mountedSource: { ...source, artworkError: undefined, ...artwork },
  })
  return { artwork: reportedArtwork(artwork.artwork) }
}

export async function enrichMountedRoms(library: Library, retryErrors = true, options: EnrichmentOptions = {}) {
  const pending = await library
    .select()
    .from(romTable)
    .where(
      and(
        eq(romTable.status, statusEnum.normal),
        isNull(romTable.userId),
        isNotNull(romTable.mountedSource),
        sql`json_extract(${romTable.mountedSource}, '$.available') = 1`,
        sql`(
          json_extract(${romTable.mountedSource}, '$.metadata') IN ('pending', 'disabled')
          OR (${retryErrors ? 1 : 0} = 1 AND
            json_extract(${romTable.mountedSource}, '$.metadata') = 'error'
            AND coalesce(json_extract(${romTable.mountedSource}, '$.metadataAttemptedAt'), 0) < ${Date.now() - 300_000}
          )
        )`,
      ),
    )
    .orderBy(sql`CASE WHEN json_extract(${romTable.mountedSource}, '$.metadata') = 'error' THEN 1 ELSE 0 END`)
    .limit(50)
  for (const rom of pending) {
    try {
      await enrichMountedRom(library, rom, options)
    } catch {
      // Each failed attempt is persisted without discarding earlier metadata or cached digests.
    }
  }
  return pending.length === 50
}
