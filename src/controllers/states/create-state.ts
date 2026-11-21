import path from 'node:path'
import { and, desc, eq } from 'drizzle-orm'
import { getContext } from 'hono/context-storage'
import { HTTPException } from 'hono/http-exception'
import { getRunTimeEnv } from '#@/constants/env.ts'
import { isCompatiblePlaylistState } from '#@/constants/mounted-library.ts'
import { stateTable } from '#@/databases/schema.ts'
import { getMountedLibrary } from '#@/utils/server/mounted-library-runtime.ts'
import { nanoid } from '#@/utils/server/nanoid.ts'
import { requireRom } from '#@/utils/server/rom-access.ts'
import { deleteStates } from './delete-states.ts'

interface CreateStateParams {
  core: string
  disc?: number
  playlistRevision?: string
  rom: string
  state: Blob
  thumbnail: Blob
  type: 'auto' | 'manual'
}

export async function createState({ core, disc, playlistRevision, rom, state, thumbnail, type }: CreateStateParams) {
  const { currentUser, db, storage } = getContext().var
  if (!currentUser) {
    throw new Error('Unauthorized')
  }

  const romResult = await requireRom(rom)
  const playlist = romResult.mountedSource?.playlist
  const binding = disc && playlistRevision ? { disc, revision: playlistRevision } : null
  if (romResult.mountedSource?.playlistIssue || !isCompatiblePlaylistState(playlist, binding)) {
    throw new HTTPException(409, { message: 'This save does not match the mounted playlist; reload the game' })
  }
  if (playlist && binding) {
    const library = getMountedLibrary()
    if (core !== 'pcsx_rearmed' || !library) {
      throw new HTTPException(409, { message: 'This save requires the mounted PlayStation playlist' })
    }
    await library.assertPlaylistDiscCurrent(romResult.id, binding.revision, binding.disc)
  } else if (disc !== undefined || playlistRevision !== undefined) {
    throw new HTTPException(400, { message: 'Disc metadata is only accepted for mounted playlists' })
  }

  const id = nanoid()
  const stateFileId = path.join('states', currentUser.id, romResult.platform, rom, `${id}.state`)
  await storage.put(stateFileId, state)
  const thumbnailFileId = path.join('states', currentUser.id, romResult.platform, rom, `${id}.png`)
  await storage.put(thumbnailFileId, thumbnail)

  const [stateResult] = await db.library
    .insert(stateTable)
    .values({
      core,
      fileId: stateFileId,
      platform: romResult.platform,
      playlist: binding,
      romId: romResult.id,
      thumbnailFileId,
      type,
      userId: currentUser.id,
    })
    .returning()

  if (type === 'auto') {
    const existingAutoStates = await db.library
      .select()
      .from(stateTable)
      .where(
        and(
          eq(stateTable.userId, currentUser.id),
          eq(stateTable.romId, romResult.id),
          eq(stateTable.status, 1),
          eq(stateTable.type, 'auto'),
        ),
      )
      .orderBy(desc(stateTable.createdAt))
    const maxAutoStates = Math.trunc(Number(getRunTimeEnv().RETROASSEMBLY_RUN_TIME_MAX_AUTO_STATES_PER_ROM)) || 20
    if (existingAutoStates.length > maxAutoStates) {
      const idsToDelete = existingAutoStates.slice(maxAutoStates).map((s) => s.id)
      await deleteStates(idsToDelete)
    }
  }

  return stateResult
}
