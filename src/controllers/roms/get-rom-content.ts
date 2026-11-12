import { getFileContent } from '#@/utils/server/misc.ts'
import { requireRom } from '#@/utils/server/rom-access.ts'

export async function getRomContent(id: string) {
  const result = await requireRom(id)
  return getFileContent(result.fileId)
}
