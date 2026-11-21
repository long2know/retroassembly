import { createHash } from 'node:crypto'
import path from 'node:path'
import { HTTPException } from 'hono/http-exception'
import {
  mountedPlaylistMaxBytes,
  mountedPlaylistMaxDiscs,
  type MountedMediaFile,
  type MountedPlaylistIssue,
  type MountedSource,
} from '#@/constants/mounted-library.ts'
import {
  getMountedFileRevision,
  openMountedFile,
  validateMountedRelativePath,
  type MountedRoot,
} from './mounted-files.ts'

export function isMountedPlaylistPath(relative: string) {
  return path.posix.extname(relative).toLowerCase() === '.m3u'
}

function unsupportedPlaylist(code: MountedPlaylistIssue['code'], unsupportedReason: string, line?: number) {
  return { playlistIssue: { code, line }, unsupportedReason }
}

export async function inspectMountedPlaylist(
  root: MountedRoot,
  source: MountedMediaFile,
  findDisc: (relative: string) => MountedMediaFile | undefined,
): Promise<Pick<MountedSource, 'playlist' | 'playlistIssue' | 'unsupportedReason'>> {
  const { handle, revision, size } = await openMountedFile(root, source.path)
  let text: string
  try {
    if (revision !== source.revision) {
      throw new Error('Mounted playlist changed during scan; retry the scan')
    }
    if (size > mountedPlaylistMaxBytes) {
      return unsupportedPlaylist('TooLarge', 'The M3U exceeds 64 KiB. Use a smaller UTF-8 disc list.')
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    while (offset < size) {
      const { bytesRead } = await handle.read(bytes, offset, size - offset, offset)
      if (!bytesRead) {
        break
      }
      offset += bytesRead
    }
    if (offset !== size || getMountedFileRevision(await handle.stat({ bigint: true })) !== revision) {
      throw new Error('Mounted playlist changed during scan; retry the scan')
    }
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return unsupportedPlaylist('Encoding', 'The M3U is not valid UTF-8. Save the playlist as UTF-8 text.')
    }
  } finally {
    await handle.close()
  }

  const directory = path.posix.dirname(source.path)
  const discs: MountedMediaFile[] = []
  const seen = new Set<string>()
  for (const [index, rawLine] of text.split(/\r?\n/u).entries()) {
    const entry = rawLine.trim()
    if (!entry || entry.startsWith('#')) {
      continue
    }
    const line = index + 1
    if (discs.length === mountedPlaylistMaxDiscs) {
      return unsupportedPlaylist('TooMany', `List at most ${mountedPlaylistMaxDiscs} CHD discs in the M3U.`)
    }
    try {
      validateMountedRelativePath(entry)
      if (/^[a-z][a-z0-9+.-]*:|%[a-f0-9]{2}|[\p{Cc}\uFEFF]/iu.test(entry)) {
        throw new Error('Invalid playlist path')
      }
    } catch {
      return unsupportedPlaylist(
        'Path',
        `M3U line ${line}: use a relative, unescaped path inside the playlist directory.`,
        line,
      )
    }
    if (path.posix.extname(entry).toLowerCase() !== '.chd') {
      return unsupportedPlaylist('Format', `M3U line ${line}: only .chd disc images are supported.`, line)
    }
    const disc = findDisc(`${directory}/${entry}`)
    if (!disc) {
      return unsupportedPlaylist(
        'Missing',
        `M3U line ${line}: CHD not found. Check the exact filename, case and folders; links are not allowed.`,
        line,
      )
    }
    if (seen.has(disc.revision)) {
      return unsupportedPlaylist('Duplicate', `M3U line ${line}: remove the duplicate disc entry.`, line)
    }
    discs.push(disc)
    seen.add(disc.revision)
  }
  if (discs.length < 2) {
    return unsupportedPlaylist('TooFew', 'List at least two different CHD discs in the M3U, in playback order.')
  }
  return {
    playlist: {
      discs,
      revision: createHash('sha256')
        .update(JSON.stringify(['mounted-psx-m3u-v1', revision, discs]))
        .digest('hex'),
    },
  }
}

export async function openIndexedMountedMedia(root: MountedRoot, media: MountedMediaFile) {
  let file
  try {
    file = await openMountedFile(root, media.path)
  } catch (error) {
    throw new HTTPException(503, { cause: error, message: 'Mounted source unavailable or unsafe; rescan required' })
  }
  if (file.revision !== media.revision) {
    await file.handle.close()
    throw new HTTPException(409, { message: 'Mounted file changed; rescan the mounted library before loading' })
  }
  return file
}
