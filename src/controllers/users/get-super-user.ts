import { asc, eq } from 'drizzle-orm'
import { getContext } from 'hono/context-storage'
import { statusEnum, userTable } from '#@/databases/schema.ts'

export async function getSuperUser() {
  const { db } = getContext().var
  const [superUser] = await db.library
    .select({ id: userTable.id })
    .from(userTable)
    .where(eq(userTable.status, statusEnum.normal))
    .orderBy(asc(userTable.createdAt))
    .limit(1)
  return superUser
}
