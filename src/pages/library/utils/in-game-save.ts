import { decodeBase64, encodeBase64 } from 'hono/utils/encode'
import { Nostalgist } from 'nostalgist'
import { client } from '#@/api/client.ts'
import {
  getInGameSaveRomDigest,
  hasInGameSaveHeader,
  inGameSaveAccountHeader,
  inGameSaveCore,
  inGameSaveEncodedSize,
  inGameSaveMaxRomSize,
  inGameSaveSize,
} from '#@/constants/in-game-save.ts'

export type InGameSaveState =
  | { phase: 'loading' | 'unavailable' | 'unsupported' | 'conflict' }
  | { phase: 'ready' | 'loaded' | 'syncing' | 'saved' | 'failed'; version: string | null }

export interface InGameSaveSession {
  accountId: string
  controller: AbortController
  digest: string
  revision?: string
  state: InGameSaveState
}

const saveDirectory = '/home/web_user/retroarch/userdata/saves/FCEUmm'

export async function prepareDirectGame(
  options: Parameters<typeof Nostalgist.prepare>[0],
  candidate?: { fileContent: string; fileName: string },
) {
  let digest: string | undefined
  if (candidate && globalThis.crypto?.subtle) {
    const response = await fetch(candidate.fileContent, { cache: 'no-store' })
    if (!response.ok) {
      throw new Error('Could not read cartridge')
    }
    const rom = await response.blob()
    if (
      rom.size <= inGameSaveMaxRomSize &&
      hasInGameSaveHeader(new Uint8Array(await rom.slice(0, 16).arrayBuffer()), rom.size)
    ) {
      digest = await getInGameSaveRomDigest(await rom.arrayBuffer())
    }
    options = {
      ...options,
      rom: { ...candidate, fileContent: rom },
      ...(digest && {
        retroarchConfig: {
          ...options.retroarchConfig,
          block_sram_overwrite: true,
          rewind_enable: false,
          run_ahead_enabled: false,
        },
      }),
    }
  }
  return { digest, emulator: await Nostalgist.prepare(options), playlistPlayback: undefined }
}

function getSavePath(emulator: Nostalgist) {
  const [rom] = emulator.getEmulatorOptions().rom
  return `${saveDirectory}/${rom.baseName}.srm`
}

export function readCartridgeRam(emulator: Nostalgist) {
  const fs = emulator.getEmscriptenFS()
  const file = getSavePath(emulator)
  const module = emulator.getEmscriptenModule()
  const flushCommand = '_cmd_savefiles'
  if (!(flushCommand in module) || typeof module[flushCommand] !== 'function') {
    throw new Error('Save command unavailable')
  }
  // On the pinned FCEUmm build the command writes synchronously, or produces no file if there is no RAM.
  // Do not poll for a file that might never appear, or mistake the preloaded copy for a new export.
  if (fs.analyzePath(file).exists) {
    fs.unlink(file)
  }
  module[flushCommand]()
  if (fs.analyzePath(file).exists) {
    const bytes: unknown = fs.readFile(file)
    if (bytes instanceof Uint8Array && bytes.byteLength === inGameSaveSize) {
      return bytes
    }
  }
  return null
}

function requestOptions(session: InGameSaveSession, romId: string) {
  return {
    input: {
      header: { [inGameSaveAccountHeader]: session.accountId },
      param: { id: romId },
      query: { core: inGameSaveCore, revision: session.revision, romDigest: session.digest } as const,
    },
    options: {
      fetch,
      init: {
        cache: 'no-store' as const,
        signal: AbortSignal.any([session.controller.signal, AbortSignal.timeout(6000)]),
      },
    },
  }
}

export async function preloadInGameSave(emulator: Nostalgist, session: InGameSaveSession, romId: string) {
  const { input, options } = requestOptions(session, romId)
  const response = await client.roms[':id']['in-game-save'].$get(input, options)
  if (!response.ok) {
    throw new Error('Could not load in-game save')
  }
  const { data, version } = await response.json()
  if (data === null && version === null) {
    return null
  }
  if (data?.length !== inGameSaveEncodedSize || !version) {
    throw new Error('Invalid in-game save')
  }
  const bytes = decodeBase64(data)
  if (bytes.byteLength !== inGameSaveSize) {
    throw new Error('Invalid in-game save')
  }
  session.controller.signal.throwIfAborted()
  // This is the same prelaunch virtual file Nostalgist 0.23.0 writes for its sram option.
  const fs = emulator.getEmscriptenFS()
  fs.mkdirTree(saveDirectory)
  fs.writeFile(getSavePath(emulator), bytes)
  return version
}

export async function syncInGameSave(
  emulator: Nostalgist,
  session: InGameSaveSession,
  { romId, version }: { romId: string; version: string | null },
): Promise<InGameSaveState> {
  const bytes = readCartridgeRam(emulator)
  if (!bytes) {
    throw new Error('Could not export cartridge RAM')
  }
  const { input, options } = requestOptions(session, romId)
  const response = await client.roms[':id']['in-game-save'].$put(
    { ...input, json: { data: encodeBase64(Uint8Array.from(bytes).buffer), version } },
    options,
  )
  const status: number = response.status
  if (status === 409) {
    return { phase: 'conflict' }
  }
  if (!response.ok) {
    throw new Error('Could not sync in-game save')
  }
  const saved = await response.json()
  return { phase: 'saved', version: saved.version }
}
