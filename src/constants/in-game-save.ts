export const inGameSaveAccountHeader = 'x-retroassembly-account'
export const inGameSaveCore = 'fceumm'
export const inGameSaveSize = 8 * 1024
export const inGameSaveEncodedSize = Math.ceil(inGameSaveSize / 3) * 4
export const inGameSaveMaxRomSize = 16 + 32 * (16 + 8) * 1024

export function isInGameSaveCandidate(platform: string, fileName: string, core: string) {
  return core === inGameSaveCore && (platform === 'nes' || platform === 'famicom') && /\.nes$/iu.test(fileName)
}

export function hasInGameSaveHeader(header: Uint8Array, size: number) {
  // Standard iNES MMC1, battery flag set, no trainer or extended header.
  return (
    header.length >= 16 &&
    header[0] === 0x4e &&
    header[1] === 0x45 &&
    header[2] === 0x53 &&
    header[3] === 0x1a &&
    header[4] > 0 &&
    header[4] <= 32 &&
    header[5] <= 32 &&
    (header[6] === 0x12 || header[6] === 0x13) &&
    header[7] === 0 &&
    header[8] <= 1 &&
    header[9] <= 1 &&
    header.subarray(10, 16).every((byte) => byte === 0) &&
    size === 16 + (header[4] * 16 + header[5] * 8) * 1024
  )
}

export async function getInGameSaveRomDigest(bytes: BufferSource) {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
