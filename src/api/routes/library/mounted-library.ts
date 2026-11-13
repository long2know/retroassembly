import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { isMountedLibraryEnabled } from '#@/constants/env.ts'
import { isPlatformName, type PlatformName } from '#@/constants/platform.ts'
import { getMountedLibrary } from '#@/utils/server/mounted-library-runtime.ts'

function requireMountedLibrary() {
  const library = isMountedLibraryEnabled() ? getMountedLibrary() : undefined
  if (!library) {
    throw new HTTPException(404, { message: 'Mounted library is not enabled' })
  }
  return library
}

function requireMetadataNetwork() {
  const library = requireMountedLibrary()
  if (!library.getStatus().networkAllowed) {
    throw new HTTPException(403, { message: 'Mounted metadata network access is disabled by server policy' })
  }
  return library
}

const metadataScope = z.object({ platform: z.custom<PlatformName>(isPlatformName).optional() }).strict()

export const mountedLibrary = new Hono()
  .get('', (c) => c.json(requireMountedLibrary().getStatus()))
  .patch(
    '',
    zValidator(
      'json',
      z
        .object({
          automaticMetadata: z.boolean().optional(),
          scanIntervalSeconds: z.number().int().min(0).max(86_400).optional(),
        })
        .strict()
        .refine((value) => Object.keys(value).length > 0),
    ),
    (c) => c.json(requireMountedLibrary().updateSettings(c.req.valid('json'))),
  )
  .post('', async (c) => {
    const library = requireMountedLibrary()
    try {
      const result = await library.scan()
      library.scheduleEnrichment()
      return c.json(result)
    } catch (error) {
      throw new HTTPException(503, {
        cause: error,
        message: 'Mounted scan failed; previous index preserved. See scan status.',
      })
    }
  })
  .post(
    'metadata',
    zValidator('json', metadataScope.extend({ retryArtwork: z.boolean().optional() })),
    (c) => c.json(requireMetadataNetwork().refreshMetadata(c.req.valid('json'))),
  )
  .post(
    'artwork',
    zValidator('json', metadataScope),
    (c) => c.json(requireMetadataNetwork().retryArtwork(c.req.valid('json'))),
  )
