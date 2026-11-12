import { getContext } from 'hono/context-storage'
import { HTTPException } from 'hono/http-exception'
import { isMountedFileId } from '#@/constants/mounted-library.ts'
import type { PlatformName } from '#@/constants/platform.ts'
import { updatePreference } from './update-preference.ts'

export async function deleteBIOS(platform: PlatformName, fileName: string) {
  const { preference } = getContext().var

  const { bioses } = preference.emulator.platform[platform]
  if (bioses.some((bios) => bios.fileName === fileName && isMountedFileId(bios.fileId))) {
    throw new HTTPException(403, { message: 'Mounted BIOS files are read-only' })
  }

  return await updatePreference({
    emulator: {
      platform: {
        [platform]: {
          bioses: bioses.filter((bios) => bios.fileName !== fileName),
        },
      },
    },
  })
}
