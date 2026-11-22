import path from 'node:path'
import { zValidator } from '@hono/zod-validator'
import { pull } from 'es-toolkit'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { DateTime } from 'luxon'
import { z } from 'zod'
import { mountedPlaylistMaxDiscs, mountedRevisionPattern } from '#@/constants/mounted-library.ts'
import { isPlatformName, type PlatformName } from '#@/constants/platform.ts'
import { deleteLaunchRecord } from '#@/controllers/launch-records/delete-launch-record.ts'
import { createRom } from '#@/controllers/roms/create-roms.ts'
import { deleteRom } from '#@/controllers/roms/delete-rom.ts'
import { deleteRoms } from '#@/controllers/roms/delete-roms.ts'
import { getRomContent } from '#@/controllers/roms/get-rom-content.ts'
import { getRom } from '#@/controllers/roms/get-rom.ts'
import { getRoms } from '#@/controllers/roms/get-roms.ts'
import { searchRoms } from '#@/controllers/roms/search-roms.ts'
import { updateRom } from '#@/controllers/roms/update-rom.ts'
import { getStates } from '#@/controllers/states/get-states.ts'
import { dateFormatMap } from '#@/utils/isomorphic/i18n.ts'
import { getMountedLibrary } from '#@/utils/server/mounted-library-runtime.ts'
import { nanoid } from '#@/utils/server/nanoid.ts'
import { requireEditableRom, requireRom } from '#@/utils/server/rom-access.ts'
import { createFileResponse } from '../utils.ts'
import { inGameSave } from './in-game-save.ts'

async function requireMountedMetadata(id: string) {
  const rom = await requireEditableRom(id)
  const library = getMountedLibrary()
  if (!rom.mountedSource || !library) {
    throw new HTTPException(400, { message: 'This metadata endpoint requires a mounted ROM' })
  }
  return { library, rom }
}

export const roms = new Hono()
  .route(':id/in-game-save', inGameSave)
  .get('', async (c) => c.json(await getRoms()))
  .post(
    '',

    zValidator(
      'form',
      z.object({
        file: z.instanceof(File),
        md5: z.string().optional(),
        platform: z.custom<PlatformName>(isPlatformName),
      }),
    ),

    async (c) => {
      const form = c.req.valid('form')
      const rom = await createRom({ file: form.file, md5: form.md5, platform: form.platform })
      return c.json(rom)
    },
  )

  .patch(
    ':id',

    zValidator(
      'form',
      z.object({
        gameBoxartFileIds: z.string().optional(),
        gameDescription: z.string().optional(),
        gameDeveloper: z.string().optional(),
        gameGenres: z.string().optional(),
        gameName: z.string().optional(),
        gamePlayers: z.string().optional(),
        gamePublisher: z.string().optional(),
        gameReleaseDate: z.string().optional(),
        gameThumbnailFileIds: z.string().optional(),
      }),
    ),

    async (c) => {
      const { i18n, preference } = c.var
      const form = c.req.valid('form')
      const id = c.req.param('id')
      const dateFormat = preference.ui.dateFormat === 'auto' ? dateFormatMap[i18n.language] : preference.ui.dateFormat
      const gameReleaseDate = form.gameReleaseDate
        ? DateTime.fromFormat(form.gameReleaseDate, dateFormat, { zone: 'utc' })
        : undefined
      let gamePlayers: number | null | undefined
      if (form.gamePlayers !== undefined) {
        const players = Number(form.gamePlayers)
        gamePlayers = form.gamePlayers && Number.isFinite(players) ? Math.trunc(players) : null
      }
      let releaseDate: Date | null | undefined
      if (form.gameReleaseDate !== undefined) {
        releaseDate = gameReleaseDate?.isValid ? gameReleaseDate.toJSDate() : null
      }
      const rom = {
        ...Object.fromEntries(Object.entries(form).map(([key, value]) => [key, value || null])),
        gamePlayers,
        gameReleaseDate: releaseDate,
      }

      const ret = await updateRom({ id, ...rom })
      return c.json(ret)
    },
  )

  .post(
    ':id/boxart',

    zValidator(
      'form',
      z.object({
        file: z.instanceof(File),
      }),
    ),

    async (c) => {
      const form = c.req.valid('form')
      const { currentUser, storage } = c.var
      const id = c.req.param('id')
      const rom = await requireEditableRom(id)

      const extname = path.extname(form.file.name)
      const fileId = path.join('attachments', currentUser.id, rom.platform, rom.id, `${nanoid()}${extname}`)
      await storage.put(fileId, form.file)
      const updatedRom = await updateRom({ gameBoxartFileIds: fileId, id })
      return c.json(updatedRom.gameBoxartFileIds)
    },
  )

  .delete(
    ':id/boxart',

    async (c) => {
      await requireEditableRom(c.req.param('id'))
      await updateRom({ gameBoxartFileIds: null, id: c.req.param('id') })
      return c.json(null)
    },
  )

  .post(
    ':id/thumbnail',

    zValidator(
      'form',
      z.object({
        file: z.instanceof(File),
      }),
    ),

    async (c) => {
      const form = c.req.valid('form')
      const { currentUser, storage } = c.var
      const id = c.req.param('id')
      const rom = await requireEditableRom(id)

      const gameThumbnailFileIds: string[] = rom.gameThumbnailFileIds?.split(',') || []
      const extname = path.extname(form.file.name)
      const fileId = path.join('attachments', currentUser.id, rom.platform, rom.id, `${nanoid()}${extname}`)
      await storage.put(fileId, form.file)
      gameThumbnailFileIds.push(fileId)
      const updatedRom = await updateRom({ gameThumbnailFileIds: gameThumbnailFileIds.join(','), id })
      return c.json(updatedRom.gameThumbnailFileIds)
    },
  )

  .delete(
    ':id/thumbnail/:thumbnailId{.+}',

    async (c) => {
      const id = c.req.param('id')
      const thumbnailId = c.req.param('thumbnailId')
      const rom = await requireEditableRom(id)
      const gameThumbnailFileIds: string[] = rom.gameThumbnailFileIds?.split(',') || []
      pull(gameThumbnailFileIds, [thumbnailId])
      const updatedRom = await updateRom({
        gameThumbnailFileIds: gameThumbnailFileIds.length > 0 ? gameThumbnailFileIds.join(',') : null,
        id,
      })
      return c.json(updatedRom.gameThumbnailFileIds)
    },
  )

  .get(':id/content', async (c) => {
    const object = await getRomContent(c.req.param('id'))
    if (object) {
      const head = c.req.method === 'HEAD'
      if (head && object.body instanceof ReadableStream) {
        await object.body.cancel()
      }
      return createFileResponse(object, undefined, head)
    }
  })

  .get(
    ':id/discs/:disc',
    zValidator(
      'param',
      z.object({
        disc: z
          .string()
          .regex(/^[1-9]\d?$/u)
          .transform(Number)
          .pipe(z.number().max(mountedPlaylistMaxDiscs)),
        id: z.string(),
      }),
    ),
    zValidator('query', z.object({ revision: z.string().regex(mountedRevisionPattern) })),
    async (c) => {
      const { disc, id } = c.req.valid('param')
      const { revision } = c.req.valid('query')
      const rom = await requireRom(id)
      const library = getMountedLibrary()
      if (!rom.mountedSource?.playlist || !library) {
        throw new HTTPException(404, { message: 'Mounted playlist not found' })
      }
      const file = await library.readPlaylistDisc({ id, index: disc, revision }, c.req.raw.signal)
      const head = c.req.method === 'HEAD'
      if (head) {
        await file.body.cancel()
      }
      return createFileResponse(file, `disc-${disc}.chd`, head)
    },
  )

  .get(':id/match', zValidator('query', z.object({ query: z.string().trim().min(1).max(120) })), async (c) => {
    c.header('Cache-Control', 'private, no-store')
    const { library, rom } = await requireMountedMetadata(c.req.param('id'))
    return c.json(await library.searchMatches(rom, c.req.valid('query').query))
  })

  .post(
    ':id/match',
    zValidator(
      'json',
      z
        .object({
          candidateId: z.string().regex(mountedRevisionPattern),
          snapshot: z.string().regex(mountedRevisionPattern),
        })
        .strict(),
    ),
    async (c) => {
      const { library, rom } = await requireMountedMetadata(c.req.param('id'))
      return c.json(await library.applyMatch(rom, c.req.valid('json')))
    },
  )

  .post(':id/retry-artwork', async (c) => {
    const { library, rom } = await requireMountedMetadata(c.req.param('id'))
    return c.json(await library.retryGameArtwork(rom))
  })

  .post(
    ':id/identify',
    zValidator(
      'json',
      z.object({
        launchboxId: z.number().int().positive().optional(),
        libretroId: z.string().min(1).max(255).optional(),
        name: z.string().trim().min(1).max(255).optional(),
      }),
    ),
    async (c) => {
      const rom = await requireEditableRom(c.req.param('id'))
      const library = getMountedLibrary()
      if (!rom.mountedSource || !library) {
        throw new HTTPException(400, { message: 'This identification endpoint requires a mounted ROM' })
      }
      try {
        return c.json(await library.identify(rom, c.req.valid('json')))
      } catch (error) {
        if (error instanceof HTTPException) {
          throw error
        }
        throw new HTTPException(502, {
          cause: error,
          message: error instanceof Error ? error.message : 'Metadata provider failed; retry or edit manually',
        })
      }
    },
  )

  .get(
    ':id/states',

    zValidator(
      'query',
      z.object({
        type: z.enum(['auto', 'manual']).optional(),
      }),
    ),

    async (c) => {
      const query = c.req.valid('query')
      const rom = c.req.param('id')
      const states = await getStates({ rom, type: query.type })
      return c.json(states)
    },
  )

  .delete(
    ':id/launch_records',

    async (c) => {
      const rom = c.req.param('id')
      await deleteLaunchRecord({ rom })
      return c.json(null)
    },
  )

  .delete(':id', async (c) => {
    await deleteRom(c.req.param('id'))
    return c.json(null)
  })

  .delete(
    '',

    zValidator(
      'query',
      z.object({
        ids: z.string().min(1),
      }),
    ),

    async (c) => {
      const query = c.req.valid('query')
      const ids = query.ids
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
      await deleteRoms(ids)
      return c.json(null)
    },
  )

  .get(
    'search',

    zValidator(
      'query',
      z.object({
        page: z.coerce.number().default(1),
        page_size: z.coerce.number().default(100),
        platform: z.custom<PlatformName>(isPlatformName).optional(),
        query: z.string().min(1),
      }),
    ),

    async (c) => {
      const queryParams = c.req.valid('query')
      const result = await searchRoms({
        page: queryParams.page,
        pageSize: queryParams.page_size,
        platform: queryParams.platform,
        query: queryParams.query,
      })
      return c.json(result)
    },
  )
  .get(':id', async (c) => {
    const rom = await getRom({ id: c.req.param('id') })
    if (!rom) {
      throw new HTTPException(404, { message: 'ROM not found' })
    }
    return c.json(rom)
  })
