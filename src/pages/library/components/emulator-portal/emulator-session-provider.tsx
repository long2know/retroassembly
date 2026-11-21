import type { Nostalgist } from 'nostalgist'
import { createContext, type ReactNode, useContext, useMemo, useReducer, useState } from 'react'
import type { CoreName } from '#@/constants/core.ts'
import { useGamepadMapping, type GamepadMapping } from '#@/pages/library/hooks/use-gamepad-mapping.ts'

interface PreparedEmulator {
  core: CoreName
  emulator: Nostalgist
  options: Parameters<typeof Nostalgist.prepare>[0]
  romId: string
}

const EmulatorSessionContext = createContext<{
  activeEmulator: PreparedEmulator | null
  emulatorGamepadMapping: GamepadMapping
  setActiveEmulator: (session: PreparedEmulator | null) => void
} | null>(null)

export function EmulatorSessionProvider({ children }: Readonly<{ children: ReactNode }>) {
  const gamepadMapping = useGamepadMapping()
  const [emulatorGamepadMapping] = useReducer((mapping: GamepadMapping) => mapping, gamepadMapping)
  const [activeEmulator, setActiveEmulator] = useState<PreparedEmulator | null>(null)
  const session = useMemo(
    () => ({ activeEmulator, emulatorGamepadMapping, setActiveEmulator }),
    [activeEmulator, emulatorGamepadMapping],
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
