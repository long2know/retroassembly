import path from 'node:path'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { env } from 'hono/adapter'
import { getContext } from 'hono/context-storage'
import { HTTPException } from 'hono/http-exception'
import { getDirectories, isMountedLibraryEnabled } from '../../constants/env.ts'
import { isMountedFileId } from '../../constants/mounted-library.ts'
import { getMountedLibrary } from './mounted-library-runtime.ts'

function assertManagedFileId(id: string) {
  if (
    !id ||
    id === 'mounted' ||
    isMountedFileId(id) ||
    path.isAbsolute(id) ||
    /[\\\0%]/u.test(id) ||
    /^[a-z]:/iu.test(id) ||
    id.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new HTTPException(400, { message: 'Invalid or read-only storage ID' })
  }
}

export function createFilesystemStorage(storageDirectory: string) {
  async function getPath(id: string, write = false) {
    assertManagedFileId(id)
    if (write && isMountedLibraryEnabled()) {
      const library = getMountedLibrary()
      if (!library) {
        throw new HTTPException(503, { message: 'Mounted library is not initialized' })
      }
      await library.assertWritableDirectory(storageDirectory)
    }
    const root = path.resolve(storageDirectory)
    const filename = path.join(root, id)
    const { lstat } = await import('node:fs/promises')
    let current = root
    for (const segment of id.split('/')) {
      current = path.join(current, segment)
      try {
        const info = await lstat(current)
        if (info.isSymbolicLink()) {
          throw new HTTPException(400, { message: 'Storage symlinks are not allowed' })
        }
        if (write && info.isFile() && info.nlink > 1) {
          throw new HTTPException(400, { message: 'Hard-linked storage files are read-only' })
        }
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
          throw error
        }
        break
      }
    }
    return filename
  }

  return {
    async head(id: string) {
      const filePath = await getPath(id)
      const { default: fs } = await import('fs-extra')
      return fs.pathExists(filePath)
    },

    async put(id: string, file: Blob) {
      const filePath = await getPath(id, true)
      const { default: fs } = await import('fs-extra')
      await fs.ensureDir(path.dirname(filePath))
      const { constants } = await import('node:fs')
      const { open } = await import('node:fs/promises')
      const { Readable } = await import('node:stream')
      const { pipeline } = await import('node:stream/promises')
      const handle = await open(filePath, constants.O_WRONLY + constants.O_CREAT + constants.O_NOFOLLOW)
      try {
        const info = await handle.stat()
        if (info.nlink > 1) {
          throw new HTTPException(400, { message: 'Hard-linked storage files are read-only' })
        }
        await handle.truncate(0)
        const readable = Readable.fromWeb(file.stream() as NodeReadableStream)
        await pipeline(readable, handle.createWriteStream())
      } finally {
        await handle.close()
      }
    },

    async get(id: string) {
      const filePath = await getPath(id)
      const { default: fs } = await import('fs-extra')
      const buffer = await fs.readFile(filePath)
      return { body: buffer, httpEtag: `"${Date.now()}"`, size: buffer.length }
    },

    async delete(id: string) {
      const filePath = await getPath(id, true)
      const { default: fs } = await import('fs-extra')
      await fs.remove(filePath)
    },
  }
}

export function createStorage() {
  const c = getContext()
  const { BUCKET } = env<Env>(c)
  const { storageDirectory } = getDirectories()
  const managed = BUCKET || createFilesystemStorage(storageDirectory)

  async function getMountedFile(id: string) {
    if (!isMountedLibraryEnabled() || !c.var.currentUser) {
      throw new HTTPException(404, { message: 'Mounted file not found' })
    }
    const library = getMountedLibrary()
    if (!library) {
      throw new HTTPException(503, { message: 'Mounted library is not initialized' })
    }
    return await library.readFile(id)
  }

  return {
    async head(id: string) {
      if (isMountedFileId(id)) {
        const file = await getMountedFile(id)
        await file.body.cancel()
        return true
      }
      assertManagedFileId(id)
      return await managed.head(id)
    },

    async put(id: string, file: Blob) {
      assertManagedFileId(id)
      await managed.put(id, file)
    },

    async get(id: string) {
      if (isMountedFileId(id)) {
        return await getMountedFile(id)
      }
      assertManagedFileId(id)
      return await managed.get(id)
    },

    async delete(id: string) {
      assertManagedFileId(id)
      await managed.delete(id)
    },
  }
}
