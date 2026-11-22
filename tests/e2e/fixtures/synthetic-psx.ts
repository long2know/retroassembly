import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'

export const syntheticPsxPlaylist = 'Homebrew/Disc Colors.m3u'
export const syntheticPsxPbp = 'Homebrew/Standalone Magenta.PBP'
export const syntheticPsxRomCount = 5

const sectorCount = 300
const rawSectorBytes = 2352
const chdSectorBytes = 2448
const dataBytes = 2048
const hunkBytes = 8 * chdSectorBytes

function both16(buffer: Buffer, offset: number, value: number) {
  buffer.writeUInt16LE(value, offset)
  buffer.writeUInt16BE(value, offset + 2)
}

function both32(buffer: Buffer, offset: number, value: number) {
  buffer.writeUInt32LE(value, offset)
  buffer.writeUInt32BE(value, offset + 4)
}

function directoryEntry({
  directory = false,
  length,
  name,
  sector,
}: {
  directory?: boolean
  length: number
  name: string
  sector: number
}) {
  const record = Buffer.alloc(33 + name.length + (name.length % 2 === 0 ? 1 : 0))
  record[0] = record.length
  both32(record, 2, sector)
  both32(record, 10, length)
  record.set([126, 1, 1, 0, 0, 0, 0], 18)
  record[25] = directory ? 2 : 0
  both16(record, 28, 1)
  record[32] = name.length
  record.write(name, 33, 'ascii')
  return record
}

function createExecutable(color: number) {
  const words = [0x3c_08_1f_80, 0x35_08_18_10]
  function writeGpu(offset: number, value: number) {
    words.push(0x3c_09_00_00 + Math.trunc(value / 65_536), 0x35_29_00_00 + (value % 65_536), 0xad_09_00_00 + offset)
  }

  // Original MIPS program: set 320×240 video, fill VRAM with the disc's color, then loop.
  for (const word of [0, 0x08_00_00_01, 0x06_c6_02_60, 0x07_04_00_10, 0x05_00_00_00, 0x03_00_00_00]) {
    writeGpu(4, word)
  }
  for (const word of [0x02_00_00_00 + color, 0, 0x00_f0_01_40]) {
    writeGpu(0, word)
  }
  words.push(0x10_00_ff_ff, 0)
  const exe = Buffer.alloc(2 * dataBytes)
  exe.write('PS-X EXE')
  exe.writeUInt32LE(0x80_01_00_00, 0x10)
  exe.writeUInt32LE(0x80_01_00_00, 0x18)
  exe.writeUInt32LE(dataBytes, 0x1c)
  exe.writeUInt32LE(0x80_1f_ff_00, 0x30)
  for (const [index, word] of words.entries()) {
    exe.writeUInt32LE(word, dataBytes + index * 4)
  }
  return exe
}

function bcd(value: number) {
  return Math.trunc(value / 10) * 16 + (value % 10)
}

function createSyntheticPsxSectors(disc: 1 | 2 | 3 | 4, sectorBytes: number, exeSector = 22) {
  const bytes = Buffer.alloc(sectorCount * sectorBytes)
  for (let sector = 0; sector < sectorCount; sector += 1) {
    const offset = sector * sectorBytes
    const frame = sector + 150
    bytes.fill(0xff, offset + 1, offset + 11)
    bytes.set([0, bcd(Math.trunc(frame / 75)), bcd(frame % 75), 2, 0, 0, 8, 0, 0, 0, 8, 0], offset + 12)
  }
  function sectorData(sector: number) {
    const offset = sector * sectorBytes + 24
    return bytes.subarray(offset, offset + dataBytes)
  }
  const primary = sectorData(16)
  primary.write('\u0001CD001\u0001')
  primary.write('PLAYSTATION'.padEnd(32), 8)
  primary.write(`RETROASSEMBLY_DISC_${disc}`.padEnd(32), 40)
  both32(primary, 80, sectorCount)
  both16(primary, 120, 1)
  both16(primary, 124, 1)
  both16(primary, 128, dataBytes)
  both32(primary, 132, 10)
  primary.writeUInt32LE(18, 140)
  primary.writeUInt32BE(19, 148)
  primary.set(directoryEntry({ directory: true, length: dataBytes, name: '\0', sector: 20 }), 156)
  primary[881] = 1
  sectorData(17).set([0xff, 0x43, 0x44, 0x30, 0x30, 0x31, 1])
  const little = sectorData(18)
  little[0] = 1
  little.writeUInt32LE(20, 2)
  little.writeUInt16LE(1, 6)
  const big = sectorData(19)
  big[0] = 1
  big.writeUInt32BE(20, 2)
  big.writeUInt16BE(1, 6)

  const id = `SLUS_999.0${disc}`
  const config = `BOOT = cdrom:\\${id};1\r\nTCB = 4\r\nEVENT = 16\r\nSTACK = 801FFF00\r\n`
  const exe = createExecutable([0x00_00_ff, 0x00_ff_00, 0xff_00_00, 0xff_00_ff][disc - 1])
  sectorData(20).set(
    Buffer.concat([
      directoryEntry({ directory: true, length: dataBytes, name: '\0', sector: 20 }),
      directoryEntry({ directory: true, length: dataBytes, name: '\u0001', sector: 20 }),
      directoryEntry({ length: config.length, name: 'SYSTEM.CNF;1', sector: 21 }),
      directoryEntry({ length: exe.length, name: `${id};1`, sector: exeSector }),
    ]),
  )
  sectorData(21).write(config)
  sectorData(exeSector).set(exe.subarray(0, dataBytes))
  sectorData(exeSector + 1).set(exe.subarray(dataBytes))
  return bytes
}

export function createSyntheticPsxChd(disc: 1 | 2 | 3) {
  const hunkCount = Math.ceil((sectorCount * chdSectorBytes) / hunkBytes)
  const bytes = Buffer.alloc((hunkCount + 1) * hunkBytes)
  const mapOffset = 124
  const metadataOffset = mapOffset + hunkCount * 4
  const track = `TRACK:1 TYPE:MODE2_RAW SUBTYPE:NONE FRAMES:${sectorCount} PREGAP:0 PGTYPE:MODE1 PGSUB:NONE POSTGAP:0\0`

  bytes.write('MComprHD')
  bytes.writeUInt32BE(mapOffset, 8)
  bytes.writeUInt32BE(5, 12)
  bytes.writeBigUInt64BE(BigInt(sectorCount * chdSectorBytes), 32)
  bytes.writeBigUInt64BE(BigInt(mapOffset), 40)
  bytes.writeBigUInt64BE(BigInt(metadataOffset), 48)
  bytes.writeUInt32BE(hunkBytes, 56)
  bytes.writeUInt32BE(chdSectorBytes, 60)
  for (let hunk = 0; hunk < hunkCount; hunk += 1) {
    bytes.writeUInt32BE(hunk + 1, mapOffset + hunk * 4)
  }
  bytes.write('CHT2', metadataOffset)
  bytes.writeUInt32BE(0x01_00_00_00 + track.length, metadataOffset + 4)
  bytes.write(track, metadataOffset + 16, 'ascii')
  createSyntheticPsxSectors(disc, chdSectorBytes).copy(bytes, hunkBytes)
  return bytes
}

export function createSyntheticPsxPbp(compressed = true) {
  const psar = 0x8_00
  const header = Buffer.alloc(psar + 0x10_00_00)
  header.write('\0PBP')
  header.writeUInt32LE(0x01_00_00, 4)
  for (let offset = 8; offset < 36; offset += 4) {
    header.writeUInt32LE(40, offset)
  }
  header.writeUInt32LE(psar, 36)
  header.write('PSISOIMG0000', psar)
  const toc = psar + 0x8_00
  header.set([0x41, 0, 0xa0, 0, 0, 0, 0, 1, 0, 0], toc)
  header.set([0x41, 0, 0xa1, 0, 0, 0, 0, 1, 0, 0], toc + 10)
  header.set([0x41, 0, 0xa2, 0, 0, 0, 0, 0, 4, 0], toc + 20)
  header.set([0x41, 0, 1, 0, 0, 0, 0, 0, 2, 0], toc + 30)

  // Boot from the last block so the rendered frame exercises the terminating index offset.
  const sectors = createSyntheticPsxSectors(4, rawSectorBytes, sectorCount - 2)
  const blockBytes = 16 * rawSectorBytes
  const blocks: Buffer[] = []
  let blockOffset = 0
  for (let offset = 0; offset < sectors.length; offset += blockBytes) {
    const block = Buffer.alloc(blockBytes)
    sectors.copy(block, 0, offset, offset + blockBytes)
    const bytes = compressed ? deflateRawSync(block) : block
    const index = psar + 0x40_00 + blocks.length * 32
    header.writeUInt32LE(blockOffset, index)
    header.writeUInt32LE(bytes.length, index + 4)
    blocks.push(bytes)
    blockOffset += bytes.length
  }
  return {
    bytes: Buffer.concat([header, ...blocks]),
    endPatch: { end: blockOffset, offset: psar + 0x40_00 + blocks.length * 32 },
  }
}

export async function writeSyntheticPsxMount(root: string) {
  const directory = path.join(root, 'ps1', 'Homebrew')
  await mkdir(path.join(directory, 'Discs'), { recursive: true })
  await writeFile(
    path.join(root, 'ps1', syntheticPsxPlaylist),
    '\uFEFF#EXTM3U\nDisc A.chd\nDiscs/Disc B.CHD\nDisc C.chd\n',
  )
  await writeFile(path.join(directory, 'Disc A.chd'), createSyntheticPsxChd(1))
  await writeFile(path.join(directory, 'Discs', 'Disc B.CHD'), createSyntheticPsxChd(2))
  await writeFile(path.join(directory, 'Disc C.chd'), createSyntheticPsxChd(3))
  await writeFile(path.join(root, 'ps1', syntheticPsxPbp), createSyntheticPsxPbp().bytes)
}
