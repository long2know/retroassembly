import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { z } from 'zod'
import {
  inGameSaveAccountHeader,
  inGameSaveCore,
  inGameSaveEncodedSize,
  inGameSaveSize,
} from '#@/constants/in-game-save.ts'
import { mountedRevisionPattern } from '#@/constants/mounted-library.ts'
import { getInGameSave, putInGameSave } from '#@/controllers/roms/in-game-save.ts'
import { readBoundedStream } from '#@/utils/server/read-bounded-stream.ts'

const binding = zValidator(
  'query',
  z.strictObject({
    core: z.literal(inGameSaveCore),
    revision: z.string().regex(mountedRevisionPattern).optional(),
    romDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
)
const romId = zValidator('param', z.object({ id: z.string().regex(/^[a-z\d_-]{1,128}$/iu) }))
const account = zValidator('header', z.object({ [inGameSaveAccountHeader]: z.string().min(1).max(128) }))

const limitBody = createMiddleware(async (c, next) => {
  const maxBytes = inGameSaveEncodedSize + 256
  const stream = c.req.raw.body
  if (stream) {
    const body = await readBoundedStream(stream, maxBytes)
    if (!body) {
      return c.json({ message: 'In-game save payload too large' }, 413)
    }
    c.req.raw = new Request(c.req.raw, { body, method: 'PUT' })
  }
  await next()
})

function isInGameSaveData(data: string) {
  try {
    return Uint8Array.fromBase64(data, { lastChunkHandling: 'strict' }).length === inGameSaveSize
  } catch {
    return false
  }
}

export const inGameSave = new Hono()
  .get('', romId, binding, account, async (c) =>
    c.json(
      await getInGameSave(c.req.valid('param').id, {
        ...c.req.valid('query'),
        accountId: c.req.valid('header')[inGameSaveAccountHeader],
      }),
    ),
  )
  .put(
    '',
    romId,
    binding,
    account,
    limitBody,
    zValidator(
      'json',
      z.strictObject({
        data: z.base64().length(inGameSaveEncodedSize).refine(isInGameSaveData),
        version: z.uuidv4().nullable(),
      }),
    ),
    async (c) =>
      c.json(
        await putInGameSave(
          c.req.valid('param').id,
          { ...c.req.valid('query'), accountId: c.req.valid('header')[inGameSaveAccountHeader] },
          c.req.valid('json'),
        ),
      ),
  )
