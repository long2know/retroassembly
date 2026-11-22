import { getRunTimeEnv } from '#@/constants/env.ts'
import { MountedRepairError } from './mounted-library-runtime.ts'

export function assertMountedMetadataNetworkAllowed() {
  if (getRunTimeEnv().RETROASSEMBLY_RUN_TIME_SHARED_ROM_METADATA_ENABLED !== 'true') {
    throw new MountedRepairError('metadata-policy')
  }
}

export async function readMountedProviderBytes(response: Response, limit: number, label: string) {
  const limitMiB = limit / (1024 * 1024)
  if (Number(response.headers.get('Content-Length')) > limit || !response.body) {
    await response.body?.cancel()
    throw new Error(`${label} is missing or larger than ${limitMiB} MiB`)
  }
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      size += value.byteLength
      if (size > limit) {
        throw new Error(`${label} is larger than ${limitMiB} MiB`)
      }
      chunks.push(value)
    }
  } finally {
    try {
      await reader.cancel()
    } finally {
      reader.releaseLock()
    }
  }
  if (!size) {
    throw new Error(`${label} is empty`)
  }
  return Buffer.concat(chunks, size)
}
