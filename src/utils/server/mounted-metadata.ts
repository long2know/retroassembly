import { createHash } from 'node:crypto'
import path from 'node:path'
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { DateTime } from 'luxon'
import { z } from 'zod'
import { getDirectories, getRunTimeEnv } from '#@/constants/env.ts'
import { platformMap, type PlatformName } from '#@/constants/platform.ts'
import { romTable, statusEnum } from '#@/databases/schema.ts'
import type { createDrizzle } from './drizzle.ts'
import { msleuth } from './msleuth.ts'
import { createFilesystemStorage } from './storage.ts'

type Library = ReturnType<typeof createDrizzle>['library']
type MountedRom = typeof romTable.$inferSelect

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
      name: nullableString,
      publisher: nullableString,
      releaseyear: nullableNumber,
      users: nullableNumber,
    })
    .nullish(),
})

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
  const url = getMountedCoverUrl(rom.platform, name)
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) })
  if (!response.ok) {
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

export async function enrichMountedRom(
  library: Library,
  rom: MountedRom,
  match?: { launchboxId?: number; libretroId?: string; name?: string },
) {
  const source = rom.mountedSource
  if (!source?.available) {
    throw new Error('Mounted source is unavailable')
  }
  if (getRunTimeEnv().RETROASSEMBLY_RUN_TIME_SHARED_ROM_METADATA_ENABLED !== 'true') {
    throw new Error('Mounted metadata network enrichment is disabled')
  }
  const signal = AbortSignal.timeout(15_000)
  try {
    const results =
      match?.launchboxId || match?.libretroId
        ? await msleuth.query(
            { conditions: [{ launchboxId: match.launchboxId, libretroId: match.libretroId }] },
            signal,
          )
        : await msleuth.identify(
            { files: [{ md5: '', name: match?.name || path.posix.basename(rom.fileName) }], platform: rom.platform },
            signal,
          )
    if (!results?.[0]) {
      throw new Error('Metadata provider unavailable or no match returned; retry or correct the app metadata manually')
    }
    const metadata = metadataSchema.parse(results[0])
    const { launchbox, libretro } = metadata
    const gameName = launchbox?.name || libretro?.name
    if (!gameName) {
      throw new Error('No provider match was found; edit the app metadata or retry with a different name')
    }
    let gameBoxartFileIds: string | undefined
    let metadataError: string | undefined
    try {
      gameBoxartFileIds = await cacheMountedCover(rom, libretro?.name || gameName)
    } catch (error) {
      metadataError = error instanceof Error ? error.message : String(error)
      console.warn(`Mounted cover enrichment failed for ${rom.fileName}: ${metadataError}`)
    }
    const date = launchbox?.releaseDate ? DateTime.fromISO(launchbox.releaseDate) : undefined
    const year = Number(launchbox?.releaseYear || libretro?.releaseyear)
    const players = Number(launchbox?.maxPlayers || libretro?.users)
    const [updated] = await library
      .update(romTable)
      .set({
        gameBoxartFileIds: gameBoxartFileIds ?? (match ? null : rom.gameBoxartFileIds),
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
          metadata: match ? 'manual' : 'ready',
          metadataAttemptedAt: Date.now(),
          metadataError,
        },
        rawGameMetadata: { launchbox, libretro },
      })
      .where(and(eq(romTable.id, rom.id), eq(romTable.mountedSource, source)))
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
        },
      })
      .where(and(eq(romTable.id, rom.id), eq(romTable.mountedSource, source)))
    console.error(`Mounted metadata enrichment failed for ${rom.fileName}: ${message}`)
    throw error
  }
}

export async function enrichMountedRoms(library: Library, retryErrors = true) {
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
      await enrichMountedRom(library, rom)
    } catch {
      // Errors are persisted on the source record for explicit retries.
    }
  }
  return pending.length === 50
}
