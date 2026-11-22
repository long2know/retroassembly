import { crc32, deflateSync } from 'node:zlib'

export const catalogTitles = {
  n64: 'Circuit Lantern 64 (Japan)',
  original: 'Circuit Lantern (USA)',
  sequel: 'Circuit Lantern II (Europe) (Rev 1)',
}

export const atariCatalogTitles = {
  alternate: 'Copper Circuit (USA) (Rev B)',
  current: 'Copper Circuit (USA) (Rev A)',
  other: 'Copper Circuit (Europe)',
}

export const atariProviderMetadata = {
  launchbox: {
    databaseId: 7800,
    developer: 'Fixture Works',
    genres: 'Puzzle;Arcade',
    maxPlayers: 2,
    name: 'Copper Circuit',
    overview: 'A synthetic copper-track puzzle for the Atari 7800.',
    publisher: 'Fixture Studio',
    releaseDate: '1990-07-23',
    videoUrl: 'https://www.youtube.com/watch?v=RAfixture78',
  },
  libretro: {
    id: 'synthetic-atari-7800-release',
    name: atariCatalogTitles.current,
    platform: 'Atari - 7800',
  },
}

function packValue(value: number | string) {
  if (typeof value === 'number') {
    const bytes = Buffer.from([0xcd, 0, 0])
    bytes.writeUInt16BE(value, 1)
    return bytes
  }
  const bytes = Buffer.from(value)
  if (bytes.length > 31) {
    return Buffer.concat([Buffer.from([0xd9, bytes.length]), bytes])
  }
  return Buffer.concat([Buffer.from([0xa0 + bytes.length]), bytes])
}

function packRecord(record: Record<string, number | string>) {
  const entries = Object.entries(record)
  return Buffer.concat([
    Buffer.from([0x80 + entries.length]),
    ...entries.flatMap(([key, value]) => [packValue(key), packValue(value)]),
  ])
}

const catalogRecords = {
  arcade: [{ name: 'Lantern’s Circuit (World)', rom_name: 'lntrn.zip' }],
  atari7800: [
    { name: atariCatalogTitles.current, releaseyear: 1990 },
    { name: atariCatalogTitles.alternate, releaseyear: 1991 },
    { developer: 'A different studio', name: atariCatalogTitles.other, releaseyear: 1992 },
  ],
  n64: [{ name: catalogTitles.n64, releaseyear: 1998, rom_name: 'lantern64.z64' }],
  nes: [
    { name: catalogTitles.original, releaseyear: 1993, rom_name: 'lantern.nes' },
    { developer: 'Synthetic Works', name: catalogTitles.sequel, releaseyear: 1996, rom_name: 'lantern2.nes' },
    { name: catalogTitles.sequel, releaseyear: 1996, rom_name: 'alternate.nes' },
    { name: 'Circuit Lantern DX', region: 'Japan', revision: 'Rev B', rom_name: 'lanterndx.nes' },
  ],
} satisfies Record<string, Record<string, number | string>[]>

export function syntheticCatalog(system: keyof typeof catalogRecords) {
  const data = catalogRecords[system]
  const records = Buffer.concat(data.map((record) => packRecord(record)))
  const header = Buffer.alloc(16)
  header.write('RARCHDB')
  header.writeBigUInt64BE(BigInt(header.length + records.length + 1), 8)
  return Buffer.concat([header, records, Buffer.from([0xc0]), packRecord({ count: data.length })])
}

function chunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type), data])
  const header = Buffer.alloc(4)
  const crc = Buffer.alloc(4)
  header.writeUInt32BE(data.length)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([header, body, crc])
}

export function syntheticCover(variant = 1) {
  const width = 96
  const height = 136
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const stride = width * 3 + 1
  const rows = Buffer.alloc(stride * height)
  const green = variant === 1 ? 170 : 93
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * stride + x * 3 + 1
      const light = Math.abs(x - 48) + Math.abs(y - 68) < 45
      rows[index] = light ? 222 : 16
      rows[index + 1] = light ? green : 50
      rows[index + 2] = light ? 57 : 88
    }
  }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
