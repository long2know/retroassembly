import { createHash } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { Reader, Writer, ZipReader, type FileEntry } from '@zip.js/zip.js'
import type { MountedIdentification } from '#@/constants/mounted-library.ts'
import { platformMap, type PlatformName } from '#@/constants/platform.ts'
import type { romTable } from '#@/databases/schema.ts'
import { getMountedConfiguration, openMountedFile, validateMountedRelativePath, type MountedRoot } from './mounted-files.ts'

type MountedRom = typeof romTable.$inferSelect

const contentLimit = 100 * 1024 * 1024
const entryLimit = 256
const chunkSize = 64 * 1024
const containerExtensions = new Set(['.chd', '.cue', '.m3u', '.m3u8', '.iso', '.ccd', '.gdi', '.pbp', '.7z', '.rar'])

class MountedZipReader extends Reader<FileHandle> {
  private handle: FileHandle

  constructor(handle: FileHandle, size: number) {
    super(handle)
    this.handle = handle
    this.size = size
  }

  override async readUint8Array(index: number, length: number) {
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(length) || index < 0 || length < 0 || length > 4 * 1024 * 1024) {
      throw new Error('ZIP directory or read range exceeds inspection limits')
    }
    const buffer = new Uint8Array(Math.min(length, Math.max(0, this.size - index)))
    const { bytesRead } = await this.handle.read(buffer, 0, buffer.byteLength, index)
    return buffer.subarray(0, bytesRead)
  }
}

class MountedHashWriter extends Writer<string> {
  private hash = createHash('md5')
  private written = 0
  private expected: number

  constructor(expected: number) {
    super()
    this.expected = expected
  }

  override writeUint8Array(data: Uint8Array) {
    this.written += data.byteLength
    if (this.written > contentLimit) {
      throw new Error('ZIP payload exceeds the 100 MiB identification limit')
    }
    this.hash.update(data)
  }

  override getData() {
    if (this.written !== this.expected) {
      throw new Error('ZIP payload size disagrees with its directory entry')
    }
    return this.hash.digest('hex')
  }
}

function getPayloadExtensions(platform: PlatformName) {
  const extensions = new Set(platformMap[platform].fileExtensions.filter((extension) => extension !== '.zip' && !containerExtensions.has(extension)))
  if (['atari2600', 'atari5200', 'atari7800', 'genesis', 'megadrive'].includes(platform)) {
    extensions.add('.bin')
  }
  return extensions
}

async function hashFile(handle: FileHandle) {
  const hash = createHash('md5')
  const buffer = new Uint8Array(chunkSize)
  let position = 0
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position)
    if (!bytesRead) {
      break
    }
    position += bytesRead
    if (position > contentLimit) {
      throw new Error('Mounted content changed or exceeds the 100 MiB identification limit')
    }
    hash.update(buffer.subarray(0, bytesRead))
  }
  return { bytes: position, md5: hash.digest('hex') }
}

async function identifyZip(handle: FileHandle, size: number, platform: PlatformName, base: MountedIdentification) {
  const reader = new ZipReader(new MountedZipReader(handle, size), { useWebWorkers: false, chunkSize })
  try {
    const extensions = getPayloadExtensions(platform)
    let candidate: FileEntry | undefined
    let count = 0
    let expanded = 0
    const names = new Set<string>()
    for await (const entry of reader.getEntriesGenerator()) {
      count += 1
      if (count > entryLimit) {
        throw new Error('ZIP contains more than 256 entries')
      }
      if (entry.directory) {
        continue
      }
      validateMountedRelativePath(entry.filename)
      if (names.has(entry.filename) || ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) {
        throw new Error('ZIP contains duplicate paths or symbolic links')
      }
      names.add(entry.filename)
      expanded += entry.uncompressedSize
      if (!Number.isSafeInteger(expanded) || expanded > contentLimit || entry.uncompressedSize / Math.max(1, entry.compressedSize) > 1000) {
        throw new Error('ZIP expanded size or compression ratio exceeds identification limits')
      }
      if (entry.filename.split('/').some((segment) => segment.startsWith('.') || segment === '__MACOSX')) {
        continue
      }
      if (entry.encrypted) {
        throw new Error('Encrypted ZIP entries cannot be identified safely')
      }
      if (!extensions.has(path.posix.extname(entry.filename).toLowerCase())) {
        continue
      }
      if (candidate) {
        throw new Error('Ambiguous ZIP: multiple eligible ROM payloads; no member was selected')
      }
      candidate = entry
    }
    if (!candidate) {
      return { ...base, mode: 'name-only' as const, error: 'ZIP has no eligible payload for this platform; filename fallback only' }
    }
    if (!candidate.uncompressedSize) {
      throw new Error('ZIP ROM payload is empty')
    }
    const md5 = await candidate.getData(new MountedHashWriter(candidate.uncompressedSize), {
      checkSignature: true,
      chunkSize,
      signal: AbortSignal.timeout(30_000),
      useWebWorkers: false,
    })
    return { ...base, bytes: candidate.uncompressedSize, hashedAt: Date.now(), md5, mode: 'zip-entry' as const, payloadName: candidate.filename }
  } finally {
    await reader.close()
  }
}

export async function getMountedIdentification(rom: MountedRom, root?: MountedRoot): Promise<MountedIdentification> {
  const source = rom.mountedSource
  if (!source?.available) {
    throw new Error('Mounted source is unavailable')
  }
  if (source.identification?.version === 1 && source.identification.revision === source.revision) {
    return source.identification
  }
  const base: MountedIdentification = {
    mode: 'name-only',
    name: path.posix.basename(rom.fileName),
    revision: source.revision,
    version: 1,
  }
  const extension = path.posix.extname(rom.fileName).toLowerCase()
  if (source.unsupportedReason || containerExtensions.has(extension)) {
    return { ...base, error: 'Container or unsupported-format bytes are not catalog cartridge/track hashes; filename fallback only' }
  }
  const mountedRoot = root || (await getMountedConfiguration())?.roms
  if (!mountedRoot) {
    throw new Error('Mounted source configuration is unavailable')
  }
  const { handle, revision, size } = await openMountedFile(mountedRoot, source.path)
  try {
    if (revision !== source.revision) {
      throw new Error('Mounted content changed; rescan before identifying')
    }
    if (!size || size > contentLimit) {
      return { ...base, error: 'Content is empty or larger than the 100 MiB identification limit; filename fallback only' }
    }
    let result: MountedIdentification
    if (extension === '.zip' && rom.platform !== 'arcade') {
      try {
        result = await identifyZip(handle, size, rom.platform, base)
      } catch (error) {
        result = { ...base, mode: 'ambiguous', error: error instanceof Error ? error.message : 'ZIP inspection failed' }
      }
    } else {
      result = { ...base, ...(await hashFile(handle)), hashedAt: Date.now(), mode: rom.platform === 'arcade' ? 'arcade-set' : 'file' }
    }
    const info = await handle.stat({ bigint: true })
    const currentRevision = createHash('sha256')
      .update(`${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`)
      .digest('hex')
    if (currentRevision !== revision) {
      throw new Error('Mounted content changed while identifying; rescan required')
    }
    return result
  } finally {
    await handle.close()
  }
}
