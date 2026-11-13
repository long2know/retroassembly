import { createHash } from 'node:crypto'
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { DateTime } from 'luxon'
import { createClient, type IdentifyParameter, type QueryParameter } from 'msleuth/client'
import { z } from 'zod'
import { getDirectories, getRunTimeEnv } from '#@/constants/env.ts'
import type { MountedSource } from '#@/constants/mounted-library.ts'
import { platformMap, type PlatformName } from '#@/constants/platform.ts'
import { romTable, statusEnum } from '#@/databases/schema.ts'
import type { createDrizzle } from './drizzle.ts'
import type { MountedRoot } from './mounted-files.ts'
import { getMountedIdentification } from './mounted-identification.ts'
import { createFilesystemStorage } from './storage.ts'

type Library = ReturnType<typeof createDrizzle>['library']
type MountedRom = typeof romTable.$inferSelect

interface EnrichmentOptions {
  root?: MountedRoot
  retryArtwork?: boolean
  allowArtwork?: () => boolean
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

class NoProviderMatchError extends Error {}

function assertNetworkAllowed() {
  if (getRunTimeEnv().RETROASSEMBLY_RUN_TIME_SHARED_ROM_METADATA_ENABLED !== 'true') {
    throw new Error('Mounted metadata network enrichment is disabled')
  }
}

async function requestMetadata(parameter: { identify: IdentifyParameter } | { query: QueryParameter }) {
  assertNetworkAllowed()
  const env = getRunTimeEnv()
  const hosts = [env.RETROASSEMBLY_RUN_TIME_MSLEUTH_HOST, ...env.RETROASSEMBLY_RUN_TIME_MSLEUTH_FALLBACK_HOST.split(',')].filter(Boolean)
  const signal = AbortSignal.timeout(15_000)
  let lastError: unknown = new Error('No metadata provider is configured')
  for (const host of hosts) {
    try {
      const client = createClient(host, {
        async fetch(input, init) {
          assertNetworkAllowed()
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

export function getMountedCoverUrl(platform: PlatformName, name: string) {
  const system = platformMap[platform].libretroName
  const filename = `${name.replaceAll(/[&*/:`<>?\\|"]/gu, '_')}.png`
  return new URL(
    [system.includes('MAME') ? 'MAME' : system, 'Named_Boxarts', filename]
      .map((segment) => encodeURIComponent(segment))
      .join('/'),
    'https://thumbnails.libretro.com/',
  )
}

export async function cacheMountedCover(rom: MountedRom, name: string) {
  if (!rom.mountedSource) {
    throw new Error('Not a mounted ROM')
  }
  assertNetworkAllowed()
  const url = getMountedCoverUrl(rom.platform, name)
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) })
  if (response.status === 404) {
    await response.body?.cancel()
    return
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
  const limit = 10 * 1024 * 1024
  if (Number(response.headers.get('Content-Length')) > limit || !response.body) {
    await response.body?.cancel()
    throw new Error('Cover provider image is missing or larger than 10 MiB')
  }
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let size = 0
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      size += value.byteLength
      if (size > limit) {
        throw new Error('Cover provider image is larger than 10 MiB')
      }
      chunks.push(new Uint8Array(value))
    }
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
  if (!size) {
    throw new Error('Cover provider returned an empty image')
  }
  let extension = 'png'
  if (mimeType === 'image/jpeg') {
    extension = 'jpg'
  } else if (mimeType === 'image/webp') {
    extension = 'webp'
  }
  const coverKey = createHash('sha256').update(url.href).digest('hex').slice(0, 16)
  const id = `metadata/${rom.id}/${rom.mountedSource.revision}-${coverKey}.${extension}`
  const { storageDirectory } = getDirectories()
  const storage = createFilesystemStorage(storageDirectory)
  await storage.put(id, new Blob(chunks, { type: mimeType }))
  return id
}

async function resolveArtwork(rom: MountedRom, metadata: z.infer<typeof metadataSchema>, options: EnrichmentOptions) {
  const source = rom.mountedSource
  if (!source) {
    throw new Error('Not a mounted ROM')
  }
  if (rom.gameBoxartFileIds) {
    const manual = rom.gameBoxartFileIds.split(',').some((id) => !id.startsWith('metadata/'))
    return { artwork: manual ? 'manual' as const : 'ready' as const, artworkError: undefined, gameBoxartFileIds: rom.gameBoxartFileIds }
  }
  if ((!options.retryArtwork && (source.artwork === 'missing' || source.artwork === 'error')) || options.allowArtwork?.() === false) {
    return { artwork: source.artwork || 'pending', artworkError: source.artworkError, gameBoxartFileIds: rom.gameBoxartFileIds }
  }
  const names = [...new Set([metadata.libretro?.name, metadata.launchbox?.name, rom.gameName].filter((name): name is string => Boolean(name)))]
  const artworkAttemptedAt = Date.now()
  try {
    for (const name of names) {
      const id = await cacheMountedCover(rom, name)
      if (id) {
        return { artwork: 'ready' as const, artworkAttemptedAt, artworkError: undefined, gameBoxartFileIds: id }
      }
    }
    return { artwork: 'missing' as const, artworkAttemptedAt, artworkError: undefined, gameBoxartFileIds: rom.gameBoxartFileIds }
  } catch (error) {
    const artworkError = error instanceof Error ? error.message : String(error)
    console.warn(`Mounted artwork request failed: ${artworkError}`)
    return { artwork: 'error' as const, artworkAttemptedAt, artworkError, gameBoxartFileIds: rom.gameBoxartFileIds }
  }
}

export async function enrichMountedRom(
  library: Library,
  rom: MountedRom,
  match?: { launchboxId?: number; libretroId?: string; name?: string },
  options: EnrichmentOptions = {},
) {
  if (!rom.mountedSource?.available) {
    throw new Error('Mounted source is unavailable')
  }
  assertNetworkAllowed()
  if (rom.mountedSource.metadata === 'manual' && !match) {
    return rom
  }
  let source: MountedSource = rom.mountedSource
  try {
    const identification = await getMountedIdentification(rom, options.root)
    if (source.identification !== identification) {
      const nextSource = { ...source, identification }
      const [cached] = await library
        .update(romTable)
        .set({ mountedSource: nextSource })
        .where(and(eq(romTable.id, rom.id), eq(romTable.status, statusEnum.normal), eq(romTable.mountedSource, source)))
        .returning()
      if (!cached) {
        throw new Error('Metadata changed during enrichment; the newer edit was preserved')
      }
      source = nextSource
    }
    if (identification.mode === 'ambiguous' && !match) {
      throw new Error(identification.error || 'Ambiguous ZIP requires an explicit manual metadata match')
    }
    const results = match?.launchboxId || match?.libretroId
      ? await requestMetadata({ query: { conditions: [{ launchboxId: match.launchboxId, libretroId: match.libretroId }] } })
      : await requestMetadata({ identify: { files: [{ md5: match ? undefined : identification.md5, name: match?.name || identification.name }], platform: rom.platform } })
    if (!results?.[0]) {
      throw new NoProviderMatchError('No provider match was found; edit the app metadata or retry with a different name')
    }
    const metadata = metadataSchema.parse(results[0])
    const { launchbox, libretro } = metadata
    const gameName = launchbox?.name || libretro?.name
    if (!gameName) {
      throw new NoProviderMatchError('No provider match was found; edit the app metadata or retry with a different name')
    }
    const artwork = await resolveArtwork({ ...rom, gameName, mountedSource: source }, metadata, options)
    const date = launchbox?.releaseDate ? DateTime.fromISO(launchbox.releaseDate) : undefined
    const year = Number(launchbox?.releaseYear || libretro?.releaseyear)
    const players = Number(launchbox?.maxPlayers || libretro?.users)
    const [updated] = await library
      .update(romTable)
      .set({
        gameBoxartFileIds: artwork.gameBoxartFileIds,
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
          artwork: artwork.artwork,
          artworkAttemptedAt: artwork.artworkAttemptedAt ?? source.artworkAttemptedAt,
          artworkError: artwork.artworkError,
          identification: {
            ...identification,
            confidence: !match && identification.md5 && libretro?.md5?.toLowerCase() === identification.md5 ? 'content' : 'filename',
          },
          metadata: match ? 'manual' : 'ready',
          metadataAttemptedAt: Date.now(),
          metadataError: undefined,
          metadataOutcome: 'matched',
        },
        rawGameMetadata: { launchbox, libretro },
      })
      .where(and(eq(romTable.id, rom.id), eq(romTable.status, statusEnum.normal), eq(romTable.mountedSource, source)))
      .returning()
    if (!updated) {
      throw new Error('Metadata changed during enrichment; the newer edit was preserved')
    }
    return updated
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await library
      .update(romTable)
      .set({
        mountedSource: {
          ...source,
          metadata: source.metadata === 'manual' ? 'manual' : 'error',
          metadataAttemptedAt: Date.now(),
          metadataError: message,
          metadataOutcome: error instanceof NoProviderMatchError ? 'no-match' : 'error',
        },
      })
      .where(and(eq(romTable.id, rom.id), eq(romTable.status, statusEnum.normal), eq(romTable.mountedSource, source)))
    if (!(error instanceof NoProviderMatchError)) {
      console.warn(`Mounted metadata request failed: ${message}`)
    }
    throw error
  }
}

export async function retryMountedArtwork(library: Library, rom: MountedRom) {
  const source = rom.mountedSource
  if (!source?.available || source.metadata === 'manual' || rom.gameBoxartFileIds) {
    return rom
  }
  assertNetworkAllowed()
  const metadata = metadataSchema.parse(rom.rawGameMetadata || {})
  const artwork = await resolveArtwork(rom, metadata, { retryArtwork: true })
  const [updated] = await library
    .update(romTable)
    .set({
      gameBoxartFileIds: artwork.gameBoxartFileIds,
      mountedSource: { ...source, artwork: artwork.artwork, artworkAttemptedAt: artwork.artworkAttemptedAt, artworkError: artwork.artworkError },
    })
    .where(and(eq(romTable.id, rom.id), eq(romTable.status, statusEnum.normal), eq(romTable.mountedSource, source)))
    .returning()
  if (!updated) {
    throw new Error('Metadata changed during enrichment; the newer edit was preserved')
  }
  return updated
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
      await enrichMountedRom(library, rom, undefined, options)
    } catch {
      // Each failed attempt is persisted without discarding earlier metadata or cached digests.
    }
  }
  return pending.length === 50
}
