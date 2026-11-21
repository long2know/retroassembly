import type { Nostalgist } from 'nostalgist'
import { createContext, type ReactNode, useContext, useMemo, useReducer, useState } from 'react'
import type { CoreName } from '#@/constants/core.ts'
import type { MountedPlaylistState } from '#@/constants/mounted-library.ts'
import { useGamepadMapping, type GamepadMapping } from '#@/pages/library/hooks/use-gamepad-mapping.ts'
import type { PlaylistPlayback } from '#@/pages/library/utils/mounted-playlist.ts'

interface PreparedEmulator {
  core: CoreName
  emulator: Nostalgist
  options: Parameters<typeof Nostalgist.prepare>[0]
  playlistPlayback?: PlaylistPlayback
  resumePlaylistState?: { state: MountedPlaylistState; url: string }
  romId: string
}

const EmulatorSessionContext = createContext<{
  activeEmulator: PreparedEmulator | null
  emulatorGamepadMapping: GamepadMapping
  playlistStartFailed: boolean
  setActiveEmulator: (session: PreparedEmulator | null) => void
  setPlaylistStartFailed: (failed: boolean) => void
} | null>(null)

export function EmulatorSessionProvider({ children }: Readonly<{ children: ReactNode }>) {
  const gamepadMapping = useGamepadMapping()
  const [emulatorGamepadMapping] = useReducer((mapping: GamepadMapping) => mapping, gamepadMapping)
  const [activeEmulator, setActiveEmulator] = useState<PreparedEmulator | null>(null)
  const [playlistStartFailed, setPlaylistStartFailed] = useState(false)
  const session = useMemo(
    () => ({ activeEmulator, emulatorGamepadMapping, playlistStartFailed, setActiveEmulator, setPlaylistStartFailed }),
    [activeEmulator, emulatorGamepadMapping, playlistStartFailed],
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
