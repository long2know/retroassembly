import { and, eq } from 'drizzle-orm'
import { getContext } from 'hono/context-storage'
import { DateTime } from 'luxon'
import {
  getMountedManualMetadataFields,
  mountedMetadataFields,
  type MountedSource,
} from '#@/constants/mounted-library.ts'
import { romTable, statusEnum } from '#@/databases/schema.ts'
import { MountedRepairError } from '#@/utils/server/mounted-library-runtime.ts'
import { requireEditableRom } from '#@/utils/server/rom-access.ts'

interface RomUpdate {
  gameBoxartFileIds?: null | string
  gameDescription?: null | string
  gameDeveloper?: null | string
  gameGenres?: null | string
  gameName?: null | string
  gamePlayers?: null | number
  gamePublisher?: null | string
  gameReleaseDate?: Date | null
  gameThumbnailFileIds?: null | string
  id: string
}

function sameMetadataValue(previous: Date | number | string | null, submitted: Date | number | string | null) {
  if (previous instanceof Date && submitted instanceof Date) {
    return DateTime.fromJSDate(previous, { zone: 'utc' }).hasSame(
      DateTime.fromJSDate(submitted, { zone: 'utc' }),
      'day',
    )
  }
  return (previous === '' ? null : previous) === (submitted === '' ? null : submitted)
}

function mountedEdits(rom: RomUpdate, existing: typeof romTable.$inferSelect, source: MountedSource) {
  const changedFields = mountedMetadataFields.filter((field) => {
    const value = rom[field]
    return value !== undefined && !sameMetadataValue(existing[field], value)
  })
  const boxartEdited = rom.gameBoxartFileIds !== undefined
  const thumbnailsEdited =
    rom.gameThumbnailFileIds !== undefined && rom.gameThumbnailFileIds !== existing.gameThumbnailFileIds
  if (!changedFields.length && !boxartEdited && !thumbnailsEdited) {
    return
  }
  return {
    ...Object.fromEntries(changedFields.map((field) => [field, rom[field]])),
    gameBoxartFileIds: boxartEdited ? rom.gameBoxartFileIds : undefined,
    gameThumbnailFileIds: thumbnailsEdited ? rom.gameThumbnailFileIds : undefined,
    mountedSource: {
      ...source,
      ...(boxartEdited ? { artwork: 'manual' as const, artworkError: undefined } : {}),
      catalogMatch: changedFields.includes('gameName') ? undefined : source.catalogMatch,
      manualMetadataFields: [...new Set([...getMountedManualMetadataFields(source), ...changedFields])],
      metadata: 'manual' as const,
      metadataError: undefined,
    },
  }
}

export async function updateRom(rom: RomUpdate) {
  const { db } = getContext().var
  const { library } = db

  const { id } = rom
  const existingRom = await requireEditableRom(id)
  const source = existingRom.mountedSource
  const changes = source ? mountedEdits(rom, existingRom, source) : rom
  if (!changes) {
    return existingRom
  }

  const [updatedRom] = await library
    .update(romTable)
    .set(changes)
    .where(
      source
        ? and(
            eq(romTable.id, id),
            eq(romTable.status, statusEnum.normal),
            eq(romTable.mountedSource, source),
            eq(romTable.updatedAt, existingRom.updatedAt),
          )
        : eq(romTable.id, id),
    )
    .returning()

  if (!updatedRom) {
    throw new MountedRepairError('metadata-stale')
  }
  return updatedRom
}
