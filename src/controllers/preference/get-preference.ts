import { and, eq, isNotNull } from 'drizzle-orm'
import { getContext } from 'hono/context-storage'
import { isMountedLibraryEnabled } from '#@/constants/env.ts'
import { isMountedFileId } from '#@/constants/mounted-library.ts'
import { platformMap } from '#@/constants/platform.ts'
import { resolveUserPreference, type Preference } from '#@/constants/preference.ts'
import { romTable, statusEnum, userPreferenceTable } from '#@/databases/schema.ts'
import { getMountedLibrary } from '#@/utils/server/mounted-library-runtime.ts'
import { getMountedRomCondition } from '#@/utils/server/rom-access.ts'

export async function mergeMountedPreference(preference: Preference, explicitPlatforms: boolean) {
  if (!isMountedLibraryEnabled()) {
    return preference
  }
  const mounted = getMountedLibrary()
  for (const platform of Object.values(platformMap)) {
    const mountedBioses = mounted?.getBioses(platform.name) || []
    const settings = preference.emulator.platform[platform.name]
    const uploadedBioses = settings.bioses.filter(
      (bios) => !isMountedFileId(bios.fileId) && !mountedBioses.some((mounted) => mounted.fileName === bios.fileName),
    )
    settings.bioses = [...mountedBioses, ...uploadedBioses]
  }
  if (!explicitPlatforms) {
    const { db } = getContext().var
    const sources = await db.library
      .selectDistinct({ platform: romTable.platform })
      .from(romTable)
      .where(and(getMountedRomCondition(), isNotNull(romTable.mountedSource), eq(romTable.status, statusEnum.normal)))
    preference.ui.platforms = [...new Set([...preference.ui.platforms, ...sources.map((rom) => rom.platform)])]
  }
  return preference
}

export async function getPreference() {
  const { currentUser, db } = getContext().var

  const results = await db.library
    .select({ emulator: userPreferenceTable.emulator, input: userPreferenceTable.input, ui: userPreferenceTable.ui })
    .from(userPreferenceTable)
    .where(and(eq(userPreferenceTable.userId, currentUser.id), eq(userPreferenceTable.status, 1)))

  const [userPreference] = results
  if (userPreference?.ui?.platforms) {
    userPreference.ui.platforms = userPreference.ui.platforms.filter((platform) => platform in platformMap)
  }

  return await mergeMountedPreference(resolveUserPreference(userPreference), Boolean(userPreference?.ui?.platforms))
}
