import { and, eq } from 'drizzle-orm'
import { getContext } from 'hono/context-storage'
import { HTTPException } from 'hono/http-exception'
import { stateTable } from '#@/databases/schema.ts'
import { getFileContent } from '#@/utils/server/misc.ts'

export async function getStateContent(id: string, type?: string) {
  const { currentUser, db } = getContext().var

  const [result] = await db.library
    .select()
    .from(stateTable)
    .where(and(eq(stateTable.id, id), eq(stateTable.userId, currentUser.id), eq(stateTable.status, 1)))
    .limit(1)

  if (!result) {
    throw new HTTPException(404, { message: 'State not found' })
  }
  const fileId = type === 'thumbnail' ? result.thumbnailFileId : result.fileId
  return getFileContent(fileId)
}
