import { and, eq, inArray } from 'drizzle-orm'
import { getContext } from 'hono/context-storage'
import { isMountedFileId } from '#@/constants/mounted-library.ts'
import { launchRecordTable, romTable, statusEnum } from '#@/databases/schema.ts'
import { requireEditableRom } from '#@/utils/server/rom-access.ts'

export async function deleteRoms(ids: string[]) {
  const { currentUser, db, storage } = getContext().var
  const { library } = db

  if (ids.length === 0) {
    return
  }

  for (const id of ids) {
    await requireEditableRom(id)
  }

  const deletedRoms = await library
    .update(romTable)
    .set({ status: statusEnum.deleted })
    .where(inArray(romTable.id, ids))
    .returning({ fileId: romTable.fileId })

  await library
    .update(launchRecordTable)
    .set({ status: statusEnum.deleted })
    .where(and(inArray(launchRecordTable.romId, ids), eq(launchRecordTable.userId, currentUser.id)))

  // Delete files that are no longer referenced
  const uniqueFileIds = [...new Set(deletedRoms.map((rom) => rom.fileId))]
  const stillReferencedFiles = await library
    .select({ fileId: romTable.fileId })
    .from(romTable)
    .where(and(inArray(romTable.fileId, uniqueFileIds), eq(romTable.status, statusEnum.normal)))
  const stillReferencedFileIds = new Set(stillReferencedFiles.map((row) => row.fileId))
  const filesToDelete = uniqueFileIds.filter(
    (fileId) => !isMountedFileId(fileId) && !stillReferencedFileIds.has(fileId),
  )
  await Promise.allSettled(filesToDelete.map((fileId) => storage.delete(fileId)))
}
