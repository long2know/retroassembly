import { Hono } from 'hono'
import { getRunTimeEnv } from '#@/constants/env.ts'
import { isMountedFileId } from '#@/constants/mounted-library.ts'
import { assertFileReadable } from '#@/utils/server/file-access.ts'
import { getFileContent } from '#@/utils/server/misc.ts'
import { createFileResponse } from '../utils.ts'

export const files = new Hono().get(':id{.+}', async (c) => {
  const id = c.req.param('id')
  await assertFileReadable(id)
  const runTimeEnv = getRunTimeEnv()
  if (runTimeEnv.RETROASSEMBLY_RUN_TIME_STORAGE_HOST && !isMountedFileId(id) && !id.startsWith('states/')) {
    return c.redirect(new URL(id, runTimeEnv.RETROASSEMBLY_RUN_TIME_STORAGE_HOST))
  }
  const file = await getFileContent(id)
  if (file) {
    const head = c.req.method === 'HEAD'
    if (head && file.body instanceof ReadableStream) {
      await file.body.cancel()
    }
    return createFileResponse(file, id, head)
  }
})
