import type { Nostalgist } from 'nostalgist'
import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
} from 'react'
import type { CoreName } from '#@/constants/core.ts'
import type { MountedPlaylistState } from '#@/constants/mounted-library.ts'
import { useGamepadMapping, type GamepadMapping } from '#@/pages/library/hooks/use-gamepad-mapping.ts'
import { useRom } from '#@/pages/library/hooks/use-rom.ts'
import type { InGameSaveSession } from '#@/pages/library/utils/in-game-save.ts'
import { createMountedPbpPreparation } from '#@/pages/library/utils/mounted-pbp.ts'
import type { PlaylistPlayback } from '#@/pages/library/utils/mounted-playlist.ts'

type MountedPbpPreparation = ReturnType<typeof createMountedPbpPreparation>

interface PreparedEmulator {
  core: CoreName
  emulator: Nostalgist
  inGameSave?: InGameSaveSession
  mountedPbp?: MountedPbpPreparation
  options: Parameters<typeof Nostalgist.prepare>[0]
  playlistPlayback?: PlaylistPlayback
  resumePlaylistState?: { state: MountedPlaylistState; url: string }
  romId: string
}

const EmulatorSessionContext = createContext<{
  activeEmulator: PreparedEmulator | null
  emulatorGamepadMapping: GamepadMapping
  mountedPbp?: MountedPbpPreparation
  playlistStartFailed: boolean
  setActiveEmulator: Dispatch<SetStateAction<PreparedEmulator | null>>
  setPlaylistStartFailed: (failed: boolean) => void
} | null>(null)

export function EmulatorSessionProvider({ children }: Readonly<{ children: ReactNode }>) {
  const { fileId, mountedSource } = useRom()
  const { end, offset } = mountedSource?.pbpEndPatch ?? {}
  const revision = mountedSource?.revision
  const mountedPbp = useMemo(
    () =>
      revision && end !== undefined && offset !== undefined
        ? createMountedPbpPreparation({ fileId, patch: { end, offset }, revision })
        : undefined,
    [fileId, revision, end, offset],
  )
  useEffect(() => mountedPbp?.cancel, [mountedPbp])
  const gamepadMapping = useGamepadMapping()
  const [emulatorGamepadMapping] = useReducer((mapping: GamepadMapping) => mapping, gamepadMapping)
  const [activeEmulator, setActiveEmulator] = useState<PreparedEmulator | null>(null)
  const [playlistStartFailed, setPlaylistStartFailed] = useState(false)
  const session = useMemo(
    () => ({
      activeEmulator,
      emulatorGamepadMapping,
      mountedPbp,
      playlistStartFailed,
      setActiveEmulator,
      setPlaylistStartFailed,
    }),
    [activeEmulator, emulatorGamepadMapping, mountedPbp, playlistStartFailed],
  )

  return <EmulatorSessionContext.Provider value={session}>{children}</EmulatorSessionContext.Provider>
}

export function useEmulatorSession() {
  const session = useContext(EmulatorSessionContext)
  if (!session) {
    throw new Error('useEmulatorSession must be used within EmulatorSessionProvider')
  }

  return session
}
