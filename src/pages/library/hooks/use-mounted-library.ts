import useSWR from 'swr'
import { client, parseResponse } from '#@/api/client.ts'
import type { MountedLibraryStatus } from '#@/constants/mounted-library.ts'
import { useGlobalLoaderData } from '#@/pages/hooks/use-global-loader-data.ts'

const mountedLibraryKey = { endpoint: 'mounted-library', method: 'get' }

async function fetchMountedLibrary() {
  return await parseResponse(client['mounted-library'].$get())
}

export function useMountedLibrary({ poll = false }: Readonly<{ poll?: boolean }> = {}) {
  const { env, mountedLibrary } = useGlobalLoaderData()
  const enabled = env.RETROASSEMBLY_RUN_TIME_ENABLE_SHARED_ROM_LIBRARY === 'true'
  const result = useSWR<MountedLibraryStatus, unknown>(enabled ? mountedLibraryKey : null, fetchMountedLibrary, {
    fallbackData: mountedLibrary,
    refreshInterval: poll ? (status) => (status?.running || status?.metadata.running ? 1000 : 0) : 0,
    revalidateOnFocus: poll,
    revalidateOnReconnect: poll,
  })

  return {
    ...result,
    automaticMetadataEnabled: Boolean(
      mountedLibrary?.automaticMetadataEnabled && result.data?.automaticMetadataEnabled && !result.error,
    ),
    enabled,
  }
}
