import { and, eq, or, sql } from 'drizzle-orm'
import { getContext } from 'hono/context-storage'
import { HTTPException } from 'hono/http-exception'
import { romTable, stateTable, statusEnum } from '#@/databases/schema.ts'
import { getVisibleRomCondition } from './rom-access.ts'

export async function assertFileReadable(id: string) {
  const { currentUser, db, preference } = getContext().var
  if (!currentUser) {
    throw new HTTPException(401, { message: 'Authentication required' })
  }
  if (id.startsWith('states/')) {
    const [state] = await db.library
      .select({ id: stateTable.id })
      .from(stateTable)
      .where(
        and(
          eq(stateTable.userId, currentUser.id),
          eq(stateTable.status, statusEnum.normal),
          or(eq(stateTable.fileId, id), eq(stateTable.thumbnailFileId, id)),
        ),
      )
      .limit(1)
    if (state) {
      return
    }
  } else if (id.startsWith('bioses/') || id.startsWith('mounted/bios/')) {
    if (
      Object.values(preference.emulator.platform).some((platform) => platform.bioses.some((bios) => bios.fileId === id))
    ) {
      return
    }
  } else if (id.startsWith('roms/') || id.startsWith('mounted/roms/')) {
    const [rom] = await db.library
      .select({ id: romTable.id })
      .from(romTable)
      .where(and(getVisibleRomCondition(), eq(romTable.fileId, id)))
      .limit(1)
    if (rom) {
      return
    }
  } else if (id.startsWith('attachments/') || id.startsWith('metadata/')) {
    const segments = id.split('/')
    const romId = segments[0] === 'attachments' ? segments[3] : segments[1]
    if (!romId) {
      throw new HTTPException(404, { message: 'File not found' })
    }
    const [rom] = await db.library
      .select({ id: romTable.id })
      .from(romTable)
      .where(
        and(
          getVisibleRomCondition(),
          eq(romTable.id, romId),
          or(
            sql`instr(',' || coalesce(${romTable.gameBoxartFileIds}, '') || ',', ${`,${id},`}) > 0`,
            sql`instr(',' || coalesce(${romTable.gameThumbnailFileIds}, '') || ',', ${`,${id},`}) > 0`,
          ),
        ),
      )
      .limit(1)
    if (rom) {
      return
    }
  }
  throw new HTTPException(404, { message: 'File not found' })
}
