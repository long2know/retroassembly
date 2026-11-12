import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, open, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { getRuntimeKey } from 'hono/adapter'
import { getDirectories, getRunTimeEnv, isMountedLibraryEnabled } from '#@/constants/env.ts'
import { resolveMountedPlatform } from '#@/constants/mounted-library.ts'

export interface MountedRoot {
  directory: string
  identity: string
}

export interface MountedConfiguration {
  bios?: MountedRoot
  metadataEnabled: boolean
  roms: MountedRoot
  scanInterval: number
}

function hasReadPermission(mode: bigint | number) {
  return /[4-7]/u.test(Number(mode).toString(8).slice(-3))
}

function hasDirectoryPermissions(mode: bigint | number) {
  return hasReadPermission(mode) && /[1357]/u.test(Number(mode).toString(8).slice(-3))
}

export function isContainedPath(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

export function validateMountedRelativePath(relative: string) {
  if (!relative || path.isAbsolute(relative) || /^[a-z]:/iu.test(relative) || /[\\\0]/u.test(relative)) {
    throw new Error('Invalid mounted source path')
  }
  if (relative.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Invalid mounted source path')
  }
  let decoded = relative
  for (let index = 0; index < 4; index += 1) {
    if (/%(?:2e|2f|5c|00|25)/iu.test(decoded)) {
      if (/%(?:2f|5c|00)/iu.test(decoded)) {
        throw new Error('Invalid encoded mounted source path')
      }
      try {
        decoded = decodeURIComponent(decoded)
      } catch {
        throw new Error('Invalid encoded mounted source path')
      }
      if (path.isAbsolute(decoded) || /[\\\0]/u.test(decoded) || decoded.split('/').includes('..')) {
        throw new Error('Invalid encoded mounted source path')
      }
    } else {
      break
    }
  }
}

export async function canonicalLocation(directory: string): Promise<string> {
  try {
    return await realpath(path.resolve(directory))
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw error
    }
    const parent = path.dirname(path.resolve(directory))
    if (parent === path.resolve(directory)) {
      throw error
    }
    return path.join(await canonicalLocation(parent), path.basename(directory))
  }
}

export async function validateMountedRoot(directory: string, writableDirectories: string[]): Promise<MountedRoot> {
  if (!directory || !path.isAbsolute(directory)) {
    throw new Error('Mounted source directories must be configured as absolute existing paths')
  }
  const canonical = await realpath(directory)
  const info = await stat(canonical, { bigint: true })
  if (!info.isDirectory() || !hasDirectoryPermissions(info.mode)) {
    throw new Error(`Mounted source is not a readable directory: ${directory}`)
  }
  await access(canonical, constants.R_OK + constants.X_OK)
  for (const writableDirectory of writableDirectories) {
    const writable = await canonicalLocation(writableDirectory)
    if (isContainedPath(writable, canonical) || isContainedPath(canonical, writable)) {
      throw new Error(`Mounted source ${directory} overlaps writable data/storage ${writableDirectory}`)
    }
  }
  return { directory: canonical, identity: `${info.dev}:${info.ino}` }
}

export async function assertMountedRootAvailable(root: MountedRoot) {
  const info = await stat(root.directory, { bigint: true })
  if (!info.isDirectory() || !hasDirectoryPermissions(info.mode) || `${info.dev}:${info.ino}` !== root.identity) {
    throw new Error(`Mounted source is unavailable or changed: ${root.directory}`)
  }
  await access(root.directory, constants.R_OK + constants.X_OK)
}

export async function getMountedConfiguration(): Promise<MountedConfiguration | undefined> {
  if (getRuntimeKey() !== 'node') {
    return
  }
  const env = getRunTimeEnv()
  if (!['true', 'false'].includes(env.RETROASSEMBLY_RUN_TIME_ENABLE_SHARED_ROM_LIBRARY)) {
    throw new Error('RETROASSEMBLY_RUN_TIME_ENABLE_SHARED_ROM_LIBRARY must be true or false')
  }
  if (!isMountedLibraryEnabled()) {
    return
  }
  const { dataDirectory, storageDirectory } = getDirectories()
  const writableDirectories = [dataDirectory, storageDirectory]
  const scanInterval = Number(env.RETROASSEMBLY_RUN_TIME_SHARED_ROM_SCAN_INTERVAL)
  if (!Number.isSafeInteger(scanInterval) || scanInterval < 0 || scanInterval > 86_400) {
    throw new Error('RETROASSEMBLY_RUN_TIME_SHARED_ROM_SCAN_INTERVAL must be an integer from 0 to 86400 seconds')
  }
  for (const name of [
    'RETROASSEMBLY_RUN_TIME_ENABLE_SHARED_ROM_LIBRARY',
    'RETROASSEMBLY_RUN_TIME_SHARED_LIBRARY_ONLY',
    'RETROASSEMBLY_RUN_TIME_SHARED_ROM_METADATA_ENABLED',
  ] as const) {
    if (!['true', 'false'].includes(env[name])) {
      throw new Error(`${name} must be true or false`)
    }
  }
  const roms = await validateMountedRoot(env.RETROASSEMBLY_RUN_TIME_SHARED_ROM_DIRECTORY, writableDirectories)
  const bios = env.RETROASSEMBLY_RUN_TIME_SHARED_BIOS_DIRECTORY
    ? await validateMountedRoot(env.RETROASSEMBLY_RUN_TIME_SHARED_BIOS_DIRECTORY, writableDirectories)
    : undefined
  if (bios && (isContainedPath(roms.directory, bios.directory) || isContainedPath(bios.directory, roms.directory))) {
    throw new Error('Mounted ROM and BIOS directories must be disjoint')
  }
  return {
    bios,
    metadataEnabled: env.RETROASSEMBLY_RUN_TIME_SHARED_ROM_METADATA_ENABLED === 'true',
    roms,
    scanInterval,
  }
}

export function getMountedFileId(kind: 'bios' | 'roms', relative: string) {
  validateMountedRelativePath(relative)
  return `mounted/${kind}/${createHash('sha256').update(relative).digest('hex')}`
}

export async function getMountedPath(root: MountedRoot, relative: string) {
  validateMountedRelativePath(relative)
  await assertMountedRootAvailable(root)
  let current = root.directory
  for (const segment of relative.split('/')) {
    current = path.join(current, segment)
    const info = await lstat(current)
    if (info.isSymbolicLink()) {
      throw new Error('Symbolic links are not allowed in mounted sources')
    }
  }
  const canonical = await realpath(current)
  if (!isContainedPath(root.directory, canonical) || canonical === root.directory) {
    throw new Error('Mounted source escapes its root')
  }
  return canonical
}

export async function openMountedFile(root: MountedRoot, relative: string) {
  const filename = await getMountedPath(root, relative)
  const handle = await open(filename, constants.O_RDONLY + constants.O_NOFOLLOW)
  try {
    const actualPath =
      process.platform === 'linux' ? await realpath(`/proc/self/fd/${handle.fd}`) : await realpath(filename)
    if (!isContainedPath(root.directory, actualPath)) {
      throw new Error('Mounted source escapes its root')
    }
    const info = await handle.stat({ bigint: true })
    if (!info.isFile() || !hasReadPermission(info.mode)) {
      throw new Error('Mounted source is not a readable regular file')
    }
    const revision = createHash('sha256')
      .update(`${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`)
      .digest('hex')
    return { handle, revision, size: Number(info.size) }
  } catch (error) {
    await handle.close()
    throw error
  }
}

export async function getMountedFileInfo(root: MountedRoot, relative: string) {
  const { handle, revision, size } = await openMountedFile(root, relative)
  await handle.close()
  return { revision, size }
}

export async function* walkMountedFiles(root: MountedRoot, relative = '', systemsOnly = false): AsyncGenerator<string> {
  await assertMountedRootAvailable(root)
  const directory = relative ? await getMountedPath(root, relative) : root.directory
  const info = await stat(directory)
  if (!hasDirectoryPermissions(info.mode)) {
    throw new Error(`Unreadable mounted directory: ${relative}`)
  }
  const files = await readdir(directory, { withFileTypes: true })
  const entries = files.toSorted((first, second) => first.name.localeCompare(second.name, 'en'))
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue
    }
    if (!relative && systemsOnly && (!entry.isDirectory() || !resolveMountedPlatform(entry.name))) {
      continue
    }
    const child = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      yield* walkMountedFiles(root, child, systemsOnly)
    } else if (entry.isFile()) {
      yield child
    }
  }
}
