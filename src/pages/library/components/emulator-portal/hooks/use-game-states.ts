import type { Nostalgist } from 'nostalgist'
import useSWRImmutable from 'swr/immutable'
import useSWRMutation from 'swr/mutation'
import { client, parseResponse } from '#@/api/client.ts'
import { useShowGameOverlayContent } from '#@/pages/library/atoms.ts'
import type { PlaylistPlayback } from '#@/pages/library/utils/mounted-playlist.ts'
import { useEmulator } from './use-emulator.ts'

const { $get, $post } = client.states

interface SaveInput {
  state?: File
  thumbnail?: File
}

async function getStateAndThumbnail(
  emulator: Nostalgist,
  playlistPlayback?: PlaylistPlayback,
  { state, thumbnail }: SaveInput = {},
) {
  if (state) {
    if (playlistPlayback) {
      throw new Error('External states do not have a playlist revision and disc')
    }
    return { multiDiscIndex: undefined, state, thumbnail: thumbnail ?? (await emulator.screenshot()) }
  }
  const result = await (playlistPlayback ? playlistPlayback.saveState() : emulator.saveState())
  return { ...result, thumbnail: thumbnail ?? result.thumbnail ?? (await emulator.screenshot()) }
}

async function forceGetEmulatorThumbnail(emulator: Nostalgist, resolution: { width: number; height: number }) {
  const source = emulator.getCanvas()
  const { width, height } = source
  let sw: number
  let sh: number
  let sx: number
  let sy: number
  if (width / height > resolution.width / resolution.height) {
    sh = height
    sw = Math.round(height * (resolution.width / resolution.height))
    sx = Math.round((width - sw) / 2)
    sy = 0
  } else {
    sw = width
    sh = Math.round(width / (resolution.width / resolution.height))
    sx = 0
    sy = Math.round((height - sh) / 2)
  }
  const target = document.createElement('canvas')
  target.width = sw
  target.height = sh
  const context = target.getContext('2d')
  return await new Promise<Blob>((resolve) => {
    requestAnimationFrame(() => {
      // @ts-expect-error let's assume the context is always available
      context.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh)
      target.toBlob((blob) => {
        if (blob) {
          resolve(blob)
        }
      })
    })
  })
}

export function useGameStates() {
  const { core, emulator, playlistPlayback, romId } = useEmulator()
  const [showGameOverlay] = useShowGameOverlayContent()

  const {
    data: manualStates,
    isLoading: isStatesLoading,
    mutate: reloadStates,
  } = useSWRImmutable(
    romId ? { endpoint: '/api/v1/roms/:id/states', query: { rom: romId, type: 'manual' } as const } : false,
    ({ query }) => parseResponse($get({ query })),
  )

  const { data: autoStates, mutate: reloadAutoStates } = useSWRImmutable(
    romId ? { endpoint: '/api/v1/roms/:id/states', query: { rom: romId, type: 'auto' } as const } : false,
    ({ query }) => parseResponse($get({ query })),
    { dedupingInterval: 0, revalidateOnMount: true },
  )

  const states = [...(manualStates || []), ...(autoStates || [])]

  async function save(type: 'auto' | 'manual', arg?: SaveInput) {
    if (!emulator || !core || !romId) {
      throw new Error('invalid emulator or core or rom')
    }
    const result = await getStateAndThumbnail(emulator, playlistPlayback, arg)
    const thumbnail =
      core === 'mupen64plus_next'
        ? await forceGetEmulatorThumbnail(emulator, { height: 3, width: 4 })
        : result.thumbnail
    await parseResponse(
      $post({
        form: {
          core,
          ...(playlistPlayback && {
            disc: String(result.multiDiscIndex),
            playlistRevision: playlistPlayback.playlist.revision,
          }),
          rom: romId,
          state: new File([result.state], 'game.state'),
          thumbnail: new File([thumbnail], 'game.png'),
          type,
        },
      }),
    )
  }

  const { isMutating: isSavingManualState, trigger: saveManualState } = useSWRMutation(
    '/api/v1/states',
    async (_key, { arg }: { arg?: SaveInput }) => {
      await save('manual', arg)
      await Promise.all([reloadStates(), reloadAutoStates()])
    },
  )

  const { isMutating: isSavingAutoState, trigger: saveAutoState } = useSWRMutation('/api/v1/states', async () => {
    await save('auto')
    await reloadAutoStates()
  })

  return {
    isSavingAutoState,
    isSavingManualState,
    isStatesLoading,
    reloadAutoStates,
    reloadStates,
    saveAutoState,
    saveManualState,
    showGameOverlay,
    states,
  }
}
