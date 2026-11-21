import { and, desc, eq, sql } from 'drizzle-orm'
import { getContext } from 'hono/context-storage'
import type { MountedPlaylist } from '#@/constants/mounted-library.ts'
import { stateTable } from '#@/databases/schema.ts'

export type States = Awaited<ReturnType<typeof getStates>>
export type State = States[number]

export async function getStates({
  core,
  limit,
  playlist,
  rom,
  type = 'manual',
}: {
  core?: string
  limit?: number
  playlist?: MountedPlaylist
  rom: string
  type?: 'auto' | 'manual' | 'all'
}) {
  const { currentUser, db } = getContext().var

  const conditions = [eq(stateTable.userId, currentUser.id), eq(stateTable.status, 1)]
  if (rom) {
    conditions.push(eq(stateTable.romId, rom))
  }
  if (type === 'auto' || type === 'manual') {
    conditions.push(eq(stateTable.type, type))
  }
  if (core) {
    conditions.push(eq(stateTable.core, core))
  }
  if (playlist) {
    conditions.push(
      sql`json_extract(${stateTable.playlist}, '$.revision') = ${playlist.revision}`,
      sql`json_type(${stateTable.playlist}, '$.disc') = 'integer'`,
      sql`json_extract(${stateTable.playlist}, '$.disc') between 1 and ${playlist.discs.length}`,
    )
  }

  const where = and(...conditions)
  const query = db.library.select().from(stateTable).where(where).orderBy(desc(stateTable.createdAt))

  if (limit) {
    query.limit(limit)
  }

  const results = await query
  return results
}
