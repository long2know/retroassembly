import { getContext } from 'hono/context-storage'
import { HTTPException } from 'hono/http-exception'
import { launchRecordTable } from '#@/databases/schema.ts'
import { requireRom } from '#@/utils/server/rom-access.ts'

interface CreateRomParams {
  core: string
  rom: string
}

export async function createLaunchRecord(params: CreateRomParams) {
  const { currentUser, db } = getContext().var
  const { library } = db

  const rom = await requireRom(params.rom)
  if (rom.mountedSource?.unsupportedReason) {
    throw new HTTPException(422, { message: rom.mountedSource.unsupportedReason })
  }

  const [result] = await library
    .insert(launchRecordTable)
    .values({
      core: params.core,
      platform: rom.platform,
      romId: rom.id,
      userId: currentUser.id,
    })
    .returning()

  return result
}
