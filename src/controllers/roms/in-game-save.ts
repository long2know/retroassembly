import { and, eq, exists, sql } from 'drizzle-orm'
import { getContext } from 'hono/context-storage'
import { HTTPException } from 'hono/http-exception'
import {
  getInGameSaveRomDigest,
  hasInGameSaveHeader,
  inGameSaveCore,
  inGameSaveMaxRomSize,
  isInGameSaveCandidate,
} from '#@/constants/in-game-save.ts'
import { inGameSaveTable, romTable } from '#@/databases/schema.ts'
import { readBoundedStream } from '#@/utils/server/read-bounded-stream.ts'
import { getVisibleRomCondition, requireRom } from '#@/utils/server/rom-access.ts'
import { getRomCore } from '../preference/rom-core-preference.ts'

async function readRomBytes(fileId: string, revision?: string) {
  const { storage } = getContext().var
  try {
    const file = await storage.get(fileId, { stream: true })
    if (!file) {
      throw new HTTPException(404, { message: 'ROM file not found' })
    }
    const revisionChanged = revision && file.httpEtag !== `"${revision}"`
    if (revisionChanged || file.size > inGameSaveMaxRomSize) {
      if (file.body instanceof ReadableStream) {
        await file.body.cancel()
      }
      throw revisionChanged ? changedRom() : unsupportedRom()
    }
    const bytes =
      file.body instanceof ReadableStream ? await readBoundedStream(file.body, inGameSaveMaxRomSize) : file.body
    if (!bytes || bytes.length !== file.size) {
      throw changedRom()
    }
    return bytes
  } catch (error) {
    if (error instanceof HTTPException) {
      throw error
    }
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new HTTPException(404, { message: 'ROM file not found' })
    }
    throw new HTTPException(503, { cause: error, message: 'ROM file unavailable' })
  }
}

function changedRom() {
  return new HTTPException(409, { message: 'The game changed; exit and start again' })
}

function unsupportedRom() {
  return new HTTPException(422, { message: 'In-game save sync is not supported for this cartridge' })
}

interface SaveBinding {
  accountId: string
  revision?: string
  romDigest: string
}

async function getSaveBinding(id: string, { accountId, revision, romDigest }: SaveBinding) {
  const { currentUser, db } = getContext().var
  const rom = await requireRom(id)
  // A tab can retain a running cartridge after the browser signs in to a different account.
  if (currentUser.id !== accountId) {
    throw new HTTPException(409, { message: 'Signed-in account changed; exit and start again' })
  }
  const { fileId, fileName, mountedSource, platform } = rom
  if (
    !isInGameSaveCandidate(platform, fileName, inGameSaveCore) ||
    mountedSource?.playlist ||
    mountedSource?.unsupportedReason
  ) {
    throw unsupportedRom()
  }
  const { core } = await getRomCore(rom)
  if (core !== inGameSaveCore || revision !== mountedSource?.revision) {
    throw changedRom()
  }
  const bytes = await readRomBytes(fileId, revision)
  if (!hasInGameSaveHeader(bytes, bytes.length)) {
    throw unsupportedRom()
  }
  if ((await getInGameSaveRomDigest(bytes)) !== romDigest) {
    throw changedRom()
  }

  const userId = currentUser.id
  const source = revision ? `${revision}:${romDigest}` : romDigest
  const forSource = and(
    eq(inGameSaveTable.userId, userId),
    eq(inGameSaveTable.romId, id),
    eq(inGameSaveTable.core, core),
    eq(inGameSaveTable.source, source),
  )
  const currentRom = and(
    getVisibleRomCondition(),
    eq(romTable.id, id),
    eq(romTable.fileId, fileId),
    eq(romTable.fileName, fileName),
    eq(romTable.platform, platform),
    sql`json_extract(${romTable.mountedSource}, '$.revision') IS ${revision ?? null}`,
    sql`json_extract(${romTable.mountedSource}, '$.playlist') IS NULL`,
    sql`json_extract(${romTable.mountedSource}, '$.unsupportedReason') IS NULL`,
  )
  return { core, currentRom, forSource, library: db.library, source, userId }
}

export async function getInGameSave(id: string, binding: SaveBinding) {
  const { currentRom, forSource, library } = await getSaveBinding(id, binding)
  const [row] = await library
    .select({ data: inGameSaveTable.data, version: inGameSaveTable.version })
    .from(romTable)
    .leftJoin(inGameSaveTable, forSource)
    .where(currentRom)
    .limit(1)
  if (!row) {
    throw changedRom()
  }
  return row
}

export async function putInGameSave(id: string, binding: SaveBinding, save: { data: string; version: string | null }) {
  const { core, currentRom, forSource, library, source, userId } = await getSaveBinding(id, binding)
  const version = crypto.randomUUID()
  const { data } = save
  const found = { version: inGameSaveTable.version }
  // Each branch is one conditional statement, including the ROM visibility check.
  const [updated] =
    save.version === null
      ? await library
          .insert(inGameSaveTable)
          .select(
            library
              .select({
                core: sql<string>`${core}`.as('core'),
                data: sql<string>`${data}`.as('data'),
                romId: romTable.id,
                source: sql<string>`${source}`.as('source'),
                userId: sql<string>`${userId}`.as('user_id'),
                version: sql<string>`${version}`.as('version'),
              })
              .from(romTable)
              .where(currentRom),
          )
          .onConflictDoNothing()
          .returning(found)
      : await library
          .update(inGameSaveTable)
          .set({ data, version })
          .where(
            and(
              forSource,
              eq(inGameSaveTable.version, save.version),
              exists(library.select({ id: romTable.id }).from(romTable).where(currentRom)),
            ),
          )
          .returning(found)
  if (!updated) {
    throw new HTTPException(409, { message: 'In-game save changed; exit and start again before syncing' })
  }
  return updated
}
