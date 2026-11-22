import { Nostalgist } from 'nostalgist'
import type { MountedPbpEndPatch } from '#@/constants/mounted-library.ts'
import { getFileUrl } from './file.ts'

interface MountedPbpPlayback {
  fileId: string
  patch: MountedPbpEndPatch
  revision: string
}

export async function fetchMountedPbp({ fileId, patch, revision }: MountedPbpPlayback, signal: AbortSignal) {
  signal.throwIfAborted()
  const { end, offset } = patch
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(end) || end < 1 || end > 0xff_ff_ff_ff) {
    throw new Error('Invalid mounted PlayStation PBP end offset')
  }
  const response = await fetch(getFileUrl(fileId), { cache: 'no-store', credentials: 'same-origin', signal })
  if (response.status !== 200 || response.headers.get('ETag') !== `"${revision}"`) {
    await response.body?.cancel()
    throw new Error('Mounted PlayStation PBP is unavailable or changed; refresh the game after scanning')
  }
  const blob = await response.blob()
  signal.throwIfAborted()
  const terminatorEnd = offset + 32
  if (terminatorEnd > blob.size || end > blob.size - terminatorEnd) {
    throw new Error('Invalid mounted PlayStation PBP end offset')
  }
  const terminator = new Uint8Array(await blob.slice(offset, terminatorEnd).arrayBuffer())
  signal.throwIfAborted()
  if (terminator.some((byte) => byte !== 0)) {
    throw new Error('Mounted PlayStation PBP did not have the indexed zero-padded terminator')
  }
  const endOffset = new DataView(new ArrayBuffer(4))
  endOffset.setUint32(0, end, true)
  return new Blob([blob.slice(0, offset), endOffset.buffer, blob.slice(offset + 4)], { type: blob.type })
}

export function createMountedPbpPreparation(source: MountedPbpPlayback) {
  const pending = new Set<AbortController>()

  async function prepare(options: Parameters<typeof Nostalgist.prepare>[0], fileName: string) {
    const controller = new AbortController()
    pending.add(controller)
    try {
      const { signal } = controller
      const fileContent = await fetchMountedPbp(source, signal)
      signal.throwIfAborted()
      const emulator = await Nostalgist.prepare({ ...options, rom: { fileContent, fileName }, signal })
      signal.throwIfAborted()
      return emulator
    } finally {
      pending.delete(controller)
    }
  }

  function cancel() {
    for (const controller of pending) {
      controller.abort()
    }
  }

  return { cancel, prepare, source }
}
