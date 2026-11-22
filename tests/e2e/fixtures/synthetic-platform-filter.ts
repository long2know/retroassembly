import fs from 'node:fs/promises'
import path from 'node:path'

export const syntheticFilterRomCount = 101
export const syntheticFilterLastRomName = 'ZZ Filter Shelf 101 Literal%_ Adventure.nes'

export async function writeSyntheticPlatformFilterMount(directory: string) {
  await Promise.all(
    Array.from({ length: syntheticFilterRomCount }, (_, index) => {
      const name =
        index === syntheticFilterRomCount - 1
          ? syntheticFilterLastRomName
          : `ZZ Filter Shelf ${String(index + 1).padStart(3, '0')}.nes`
      return fs.writeFile(path.join(directory, name), `Synthetic index-only fixture ${index}\n`)
    }),
  )
}
