import { and, eq } from 'drizzle-orm'
import { getContext } from 'hono/context-storage'
import { HTTPException } from 'hono/http-exception'
import type { CoreName } from '#@/constants/core.ts'
import { platformMap } from '#@/constants/platform.ts'
import { romCorePreferenceTable, type romTable, statusEnum } from '#@/databases/schema.ts'
import { requireRom } from '#@/utils/server/rom-access.ts'
import { getStates } from '../states/get-states.ts'

type CorePreferenceRom = Pick<typeof romTable.$inferSelect, 'id' | 'mountedSource' | 'platform'>

export interface GameCorePreference {
  override: CoreName | null
  platformCore: CoreName
}

function supportsCorePreference(rom: CorePreferenceRom) {
  return !rom.mountedSource?.unsupportedReason && (platformMap[rom.platform]?.cores.length ?? 0) > 1
}

function forUserAndRom(userId: string, romId: string) {
  return and(eq(romCorePreferenceTable.userId, userId), eq(romCorePreferenceTable.romId, romId))
}

export async function getRomPlayback(rom: CorePreferenceRom) {
  const { currentUser, db, preference } = getContext().var
  const { cores } = platformMap[rom.platform]
  const configuredCore = preference.emulator.platform[rom.platform]?.core
  const platformCore = cores.includes(configuredCore) ? configuredCore : cores[0]
  let gameCorePreference: GameCorePreference | null = null
  if (supportsCorePreference(rom)) {
    const [stored] = await db.library
      .select({ core: romCorePreferenceTable.core })
      .from(romCorePreferenceTable)
      .where(and(forUserAndRom(currentUser.id, rom.id), eq(romCorePreferenceTable.status, statusEnum.normal)))
      .limit(1)
    const override = stored && cores.includes(stored.core) ? stored.core : null
    gameCorePreference = { override, platformCore }
  }
  const core = gameCorePreference?.override ?? platformCore
  const [state] = rom.mountedSource?.unsupportedReason ? [] : await getStates({ core, limit: 1, rom: rom.id })
  return { core, gameCorePreference, state }
}

export async function updateRomCorePreference(romId: string, core: CoreName | null) {
  const rom = await requireRom(romId)
  if (!supportsCorePreference(rom) || (core !== null && !platformMap[rom.platform].cores.includes(core))) {
    throw new HTTPException(422, { message: 'Emulator choice is not available for this game' })
  }

  const { currentUser, db } = getContext().var
  const userId = currentUser.id
  if (core === null) {
    await db.library
      .update(romCorePreferenceTable)
      .set({ status: statusEnum.deleted })
      .where(forUserAndRom(userId, rom.id))
    return { core }
  }
  await db.library
    .insert(romCorePreferenceTable)
    .values({ core, romId: rom.id, userId })
    .onConflictDoUpdate({
      set: { core, status: statusEnum.normal },
      target: [romCorePreferenceTable.userId, romCorePreferenceTable.romId],
    })
  return { core }
}
