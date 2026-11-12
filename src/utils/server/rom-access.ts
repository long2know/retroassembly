import { and, eq, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { getContext } from 'hono/context-storage'
import { HTTPException } from 'hono/http-exception'
import { isMountedLibraryEnabled, isMountedLibraryOnly } from '#@/constants/env.ts'
import { libraryModeEnum, romTable, statusEnum } from '#@/databases/schema.ts'

export function getMountedRomCondition() {
  return and(
    isNull(romTable.userId),
    isNotNull(romTable.mountedSource),
    sql`json_extract(${romTable.mountedSource}, '$.available') = 1`,
  )
}

export function getRomAccessCondition() {
  const { effectiveLibraryUserId } = getContext().var
  const owned = eq(romTable.userId, effectiveLibraryUserId)
  if (!isMountedLibraryEnabled()) {
    return owned
  }
  return isMountedLibraryOnly() ? getMountedRomCondition() : or(owned, getMountedRomCondition())
}

export function getVisibleRomCondition() {
  return and(getRomAccessCondition(), eq(romTable.status, statusEnum.normal))
}

export async function requireRom(id: string) {
  const { currentUser, db } = getContext().var
  if (!currentUser) {
    throw new HTTPException(401, { message: 'Authentication required' })
  }
  const [rom] = await db.library
    .select()
    .from(romTable)
    .where(and(eq(romTable.id, id), getVisibleRomCondition()))
    .limit(1)
  if (!rom) {
    throw new HTTPException(404, { message: 'ROM not found' })
  }
  return rom
}

export async function requireEditableRom(id: string) {
  const rom = await requireRom(id)
  const { currentUser, t } = getContext().var
  if (!rom.mountedSource && currentUser.libraryMode === libraryModeEnum.shared) {
    throw new HTTPException(403, { message: t('error.sharedLibraryReadOnly') })
  }
  return rom
}
