import { eq } from 'drizzle-orm'
import { getContext } from 'hono/context-storage'
import { romTable } from '#@/databases/schema.ts'
import { requireEditableRom } from '#@/utils/server/rom-access.ts'

export async function updateRom(rom: {
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
}) {
  const { db } = getContext().var
  const { library } = db

  const { id } = rom
  const existingRom = await requireEditableRom(id)

  const [updatedRom] = await library
    .update(romTable)
    .set({
      ...rom,
      ...(existingRom.mountedSource
        ? {
            mountedSource: {
              ...existingRom.mountedSource,
              metadata: 'manual',
              metadataError: undefined,
              ...(Object.hasOwn(rom, 'gameBoxartFileIds')
                ? { artwork: 'manual' as const, artworkError: undefined }
                : {}),
            },
          }
        : {}),
    })
    .where(eq(romTable.id, id))
    .returning()

  return updatedRom
}
