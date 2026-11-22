import type { FileHandle } from 'node:fs/promises'
import { promisify } from 'node:util'
import { inflateRaw } from 'node:zlib'
import { attemptAsync } from 'es-toolkit'
import type { MountedSource } from '#@/constants/mounted-library.ts'
import { getMountedFileRevision, openMountedFile, type MountedRoot } from './mounted-files.ts'

type PbpCompatibility = Pick<MountedSource, 'pbpEndPatch' | 'unsupportedReason'>

const headerBytes = 40
const tocOffset = 0x8_00
const tocEntryBytes = 10
const maxTracks = 99
const indexOffset = 0x40_00
const indexEntryBytes = 32
const dataOffset = 0x10_00_00
const sectorsPerBlock = 16
const blockBytes = sectorsPerBlock * 2352
const maxCompressedBytes = blockBytes + 100
const maxFileBytes = 0x7f_ff_ff_ff
const leadIn = 2 * 75
const inflateBlock = promisify(inflateRaw)

const malformed = { unsupportedReason: 'The PlayStation PBP is malformed or truncated.' }

const changed = 'Mounted PlayStation PBP changed during scan; retry the scan'

async function readAt(handle: FileHandle, position: number, size: number) {
  const buffer = Buffer.alloc(size)
  let offset = 0
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, position + offset)
    if (!bytesRead) {
      throw new Error(changed)
    }
    offset += bytesRead
  }
  return buffer
}

function bcd(value: number) {
  const tens = Math.trunc(value / 16)
  const units = value % 16
  return tens < 10 && units < 10 ? tens * 10 + units : -1
}

function readFrames(bytes: Buffer, offset: number) {
  const minutes = bcd(bytes[offset])
  const seconds = bcd(bytes[offset + 1])
  const frames = bcd(bytes[offset + 2])
  return minutes >= 0 && seconds >= 0 && seconds < 60 && frames >= 0 && frames < 75
    ? (minutes * 60 + seconds) * 75 + frames
    : -1
}

function getTocSectors(bytes: Buffer) {
  const trackCount = bcd(bytes[tocOffset + tocEntryBytes + 7])
  const sectors = readFrames(bytes, tocOffset + 2 * tocEntryBytes + 7)
  const startsWithData = Math.trunc(bytes[tocOffset + 3 * tocEntryBytes] / 0x40) % 2 === 1
  if (
    trackCount < 1 ||
    trackCount > maxTracks ||
    bytes[tocOffset + 2] !== 0xa0 ||
    bytes[tocOffset + tocEntryBytes + 2] !== 0xa1 ||
    bytes[tocOffset + 2 * tocEntryBytes + 2] !== 0xa2 ||
    !startsWithData ||
    sectors < 1
  ) {
    return
  }
  let previousOffset = -1
  let previousStart = -1
  let requiredSectors = sectors
  for (let track = 1; track <= trackCount; track += 1) {
    const entry = tocOffset + (track + 2) * tocEntryBytes
    const offset = readFrames(bytes, entry + 3)
    const start = readFrames(bytes, entry + 7) - leadIn
    if (
      bcd(bytes[entry + 2]) !== track ||
      offset < 0 ||
      offset <= previousOffset ||
      offset >= sectors ||
      start < 0 ||
      start <= previousStart ||
      start >= sectors
    ) {
      return
    }
    if (track > 1) {
      requiredSectors = Math.max(requiredSectors, previousOffset + start - previousStart)
    }
    previousOffset = offset
    previousStart = start
  }
  return Math.max(requiredSectors, sectors + previousStart - previousOffset)
}

interface PbpBlock {
  offset: number
  length: number
}

async function inspectIndex(
  handle: FileHandle,
  psar: number,
  { payloadBytes, sectors }: { payloadBytes: number; sectors: number },
): Promise<PbpCompatibility> {
  const dataStart = psar + dataOffset
  const index = await readAt(handle, psar + indexOffset, dataOffset - indexOffset)
  let first: PbpBlock | undefined
  let last: PbpBlock | undefined
  let count = 0
  for (let entry = 0; entry < index.length; entry += indexEntryBytes) {
    const offset = index.readUInt32LE(entry)
    const length = index.readUInt32LE(entry + 4)
    const end = last ? last.offset + last.length : 0
    if (!length) {
      if (!first || !last || count * sectorsPerBlock < sectors) {
        return malformed
      }
      const needsEnd = offset === 0 && !index.subarray(entry, entry + indexEntryBytes).some((byte) => byte !== 0)
      if (offset !== end && !needsEnd) {
        return { unsupportedReason: 'The PlayStation PBP has an invalid final block index entry.' }
      }
      for (const block of count === 1 ? [first] : [first, last]) {
        const compressed = await readAt(handle, dataStart + block.offset, block.length)
        const [, decoded] = await attemptAsync(() => inflateBlock(compressed, { maxOutputLength: blockBytes }))
        if (decoded?.length !== blockBytes) {
          return {
            unsupportedReason: 'The PlayStation PBP has unreadable disc blocks. Encrypted packages are not supported.',
          }
        }
      }
      // The pinned core reads the final block using this entry, even when the writer left it zero-padded.
      return needsEnd ? { pbpEndPatch: { end, offset: psar + indexOffset + entry } } : {}
    }
    if (length > maxCompressedBytes || offset + length > payloadBytes || (last && offset !== end)) {
      return malformed
    }
    if (length === blockBytes) {
      return { unsupportedReason: 'Uncompressed blocks in PlayStation PBP are not supported by the browser core.' }
    }
    last = { length, offset }
    first ??= last
    count += 1
  }
  return malformed
}

async function getPbpCompatibility(handle: FileHandle, size: number): Promise<PbpCompatibility> {
  if (!Number.isSafeInteger(size) || size > maxFileBytes) {
    return { unsupportedReason: 'The PlayStation PBP exceeds the browser core’s file size limit.' }
  }
  if (size < headerBytes) {
    return malformed
  }
  const header = await readAt(handle, 0, headerBytes)
  if (header.toString('latin1', 0, 4) !== '\0PBP') {
    return { unsupportedReason: 'This file does not have a PBP header.' }
  }
  let psar = headerBytes
  for (let field = 8; field < headerBytes; field += 4) {
    const offset = header.readUInt32LE(field)
    if (offset < psar || offset > size) {
      return malformed
    }
    psar = offset
  }
  const prefixBytes = tocOffset + (maxTracks + 3) * tocEntryBytes
  if (size - psar < 10) {
    return malformed
  }
  const prefix = await readAt(handle, psar, Math.min(size - psar, prefixBytes))
  const signature = prefix.toString('latin1', 0, 10)
  if (signature === 'PSTITLEIMG') {
    return {
      unsupportedReason: 'Multi-disc PlayStation PBP packages are not supported. M3U playlists can list only CHDs.',
    }
  }
  if (signature.startsWith('NPUMDIMG')) {
    return { unsupportedReason: 'This is a PSP PBP, not a PlayStation disc image.' }
  }
  if ([0, 0x50, 0x4_00].some((offset) => prefix.toString('latin1', offset, offset + 4) === '\0PGD')) {
    return { unsupportedReason: 'Protected PlayStation PBP packages are not supported.' }
  }
  if (signature !== 'PSISOIMG00') {
    return {
      unsupportedReason:
        'The PBP does not contain a supported single-disc PlayStation image. PSP packages are not supported.',
    }
  }
  const dataStart = psar + dataOffset
  if (dataStart >= size) {
    return malformed
  }
  const sectors = getTocSectors(prefix)
  if (!sectors) {
    return { unsupportedReason: 'The PlayStation PBP has an invalid disc table of contents.' }
  }
  return await inspectIndex(handle, psar, { payloadBytes: size - dataStart, sectors })
}

export async function inspectMountedPbp(root: MountedRoot, relative: string) {
  const { handle, revision, size } = await openMountedFile(root, relative)
  try {
    const compatibility = await getPbpCompatibility(handle, size)
    if (getMountedFileRevision(await handle.stat({ bigint: true })) !== revision) {
      throw new Error(changed)
    }
    return { revision, ...compatibility }
  } finally {
    await handle.close()
  }
}
