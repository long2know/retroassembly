import { and, count, eq, exists, ne, notExists, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import { getContext } from 'hono/context-storage'
import { HTTPException } from 'hono/http-exception'
import { gameCollectionRomTable, gameCollectionTable, romTable, statusEnum } from '#@/databases/schema.ts'
import { getVisibleRomCondition, requireRom } from '#@/utils/server/rom-access.ts'

const collectionFields = { id: gameCollectionTable.id, name: gameCollectionTable.name }
const pageSize = 100

function getCollectionScope() {
  const { currentUser, db } = getContext().var
  if (!currentUser) {
    throw new HTTPException(401, { message: 'Authentication required' })
  }
  return { library: db.library, userId: currentUser.id }
}

function ownedCollections(userId: string, collectionId?: string) {
  return and(
    eq(gameCollectionTable.userId, userId),
    eq(gameCollectionTable.status, statusEnum.normal),
    collectionId === undefined ? undefined : eq(gameCollectionTable.id, collectionId),
  )
}

function collectionNotFound() {
  return new HTTPException(404, { message: 'Collection not found' })
}

async function findCollection(collectionId: string) {
  const { library, userId } = getCollectionScope()
  const [collection] = await library
    .select(collectionFields)
    .from(gameCollectionTable)
    .where(ownedCollections(userId, collectionId))
    .limit(1)
  return collection
}

async function requireCollection(collectionId: string) {
  if (!(await findCollection(collectionId))) {
    throw collectionNotFound()
  }
}

export async function listCollections() {
  const { library, userId } = getCollectionScope()
  return await library
    .select({ ...collectionFields, total: count(romTable.id) })
    .from(gameCollectionTable)
    .leftJoin(gameCollectionRomTable, eq(gameCollectionRomTable.collectionId, gameCollectionTable.id))
    .leftJoin(romTable, and(eq(romTable.id, gameCollectionRomTable.romId), getVisibleRomCondition()))
    .where(ownedCollections(userId))
    .groupBy(gameCollectionTable.id)
    .orderBy(gameCollectionTable.nameKey)
}

export async function getCollectionGames(collectionId: string, requestedPage: number) {
  const collection = await findCollection(collectionId)
  if (!collection) {
    return null
  }
  const { library } = getCollectionScope()
  const visibleMember = and(eq(romTable.id, gameCollectionRomTable.romId), getVisibleRomCondition())
  const inCollection = eq(gameCollectionRomTable.collectionId, collectionId)
  const [{ total }] = await library
    .select({ total: count() })
    .from(gameCollectionRomTable)
    .innerJoin(romTable, visibleMember)
    .where(inCollection)
  const pages = Math.ceil(total / pageSize)
  const current = Math.min(requestedPage, pages || 1)
  const roms = await library
    .select({
      fileName: romTable.fileName,
      gameBoxartFileIds: romTable.gameBoxartFileIds,
      gameName: romTable.gameName,
      id: romTable.id,
      mountedSource: sql<boolean>`${romTable.mountedSource} IS NOT NULL`.mapWith(Boolean),
      platform: romTable.platform,
      rawGameMetadata: romTable.rawGameMetadata,
    })
    .from(gameCollectionRomTable)
    .innerJoin(romTable, visibleMember)
    .where(inCollection)
    .orderBy(sql`LOWER(${romTable.fileName})`, romTable.id)
    .limit(pageSize)
    .offset((current - 1) * pageSize)

  for (const rom of roms) {
    const libretro = rom.rawGameMetadata?.libretro
    rom.rawGameMetadata = { libretro: { name: libretro?.name, platform: libretro?.platform } }
  }
  return { collection, pagination: { current, pages, size: pageSize, total }, roms }
}

export async function listCollectionsForRom(romId: string) {
  await requireRom(romId)
  const { library, userId } = getCollectionScope()
  return await library
    .select({
      ...collectionFields,
      includesGame: sql<boolean>`${gameCollectionRomTable.romId} IS NOT NULL`.mapWith(Boolean),
    })
    .from(gameCollectionTable)
    .leftJoin(
      gameCollectionRomTable,
      and(eq(gameCollectionRomTable.collectionId, gameCollectionTable.id), eq(gameCollectionRomTable.romId, romId)),
    )
    .where(ownedCollections(userId))
    .orderBy(gameCollectionTable.nameKey)
}

function getNameKey(name: string) {
  return name.toLowerCase().normalize('NFC')
}

export async function createCollection(name: string) {
  const { library, userId } = getCollectionScope()
  const [collection] = await library
    .insert(gameCollectionTable)
    .values({ name, nameKey: getNameKey(name), userId })
    .onConflictDoNothing()
    .returning(collectionFields)
  return collection
}

export async function renameCollection(collectionId: string, name: string) {
  const { library, userId } = getCollectionScope()
  const nameKey = getNameKey(name)
  const other = alias(gameCollectionTable, 'other_collection')
  const duplicate = library
    .select({ id: other.id })
    .from(other)
    .where(
      and(
        eq(other.userId, userId),
        eq(other.status, statusEnum.normal),
        eq(other.nameKey, nameKey),
        ne(other.id, collectionId),
      ),
    )
  const [collection] = await library
    .update(gameCollectionTable)
    .set({ name, nameKey })
    .where(and(ownedCollections(userId, collectionId), notExists(duplicate)))
    .returning(collectionFields)
  if (!collection) {
    await requireCollection(collectionId)
  }
  return collection
}

export async function deleteCollection(collectionId: string) {
  const { library, userId } = getCollectionScope()
  const [collection] = await library
    .update(gameCollectionTable)
    .set({ status: statusEnum.deleted })
    .where(ownedCollections(userId, collectionId))
    .returning({ id: gameCollectionTable.id })
  if (!collection) {
    throw collectionNotFound()
  }
}

export async function addCollectionGame(collectionId: string, romId: string) {
  const { library, userId } = getCollectionScope()
  const member = library
    .select({ collectionId: gameCollectionTable.id, romId: romTable.id })
    .from(gameCollectionTable)
    .innerJoin(romTable, and(eq(romTable.id, romId), getVisibleRomCondition()))
    .where(ownedCollections(userId, collectionId))
  const [added] = await library
    .insert(gameCollectionRomTable)
    .select(member)
    .onConflictDoNothing()
    .returning({ romId: gameCollectionRomTable.romId })
  if (!added) {
    // No row can mean an existing membership or a scope that is no longer valid.
    await requireCollection(collectionId)
    await requireRom(romId)
  }
}

export async function removeCollectionGame(collectionId: string, romId: string) {
  await requireCollection(collectionId)
  const { library, userId } = getCollectionScope()
  const owner = library
    .select({ id: gameCollectionTable.id })
    .from(gameCollectionTable)
    .where(ownedCollections(userId, collectionId))
  // No ROM lookup: a previously known ID can be removed even when it isn't visible.
  await library
    .delete(gameCollectionRomTable)
    .where(
      and(
        eq(gameCollectionRomTable.collectionId, collectionId),
        eq(gameCollectionRomTable.romId, romId),
        exists(owner),
      ),
    )
}
