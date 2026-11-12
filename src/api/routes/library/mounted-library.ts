import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { isMountedLibraryEnabled } from '#@/constants/env.ts'
import { getMountedLibrary } from '#@/utils/server/mounted-library-runtime.ts'

function requireMountedLibrary() {
  const library = isMountedLibraryEnabled() ? getMountedLibrary() : undefined
  if (!library) {
    throw new HTTPException(404, { message: 'Mounted library is not enabled' })
  }
  return library
}

export const mountedLibrary = new Hono()
  .get('', (c) => c.json(requireMountedLibrary().getStatus()))
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
