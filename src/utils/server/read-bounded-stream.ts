export async function readBoundedStream(stream: ReadableStream<Uint8Array>, maxBytes: number) {
  const reader = stream.getReader()
  const bytes = new Uint8Array(maxBytes)
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        return bytes.subarray(0, size)
      }
      if (value.byteLength > maxBytes - size) {
        await reader.cancel()
        return null
      }
      bytes.set(value, size)
      size += value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
}
