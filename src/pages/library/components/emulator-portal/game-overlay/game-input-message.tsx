import { capitalize, compact } from 'es-toolkit'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useGamepadMapping } from '#@/pages/library/hooks/use-gamepad-mapping.ts'
import { useGamepads } from '#@/pages/library/hooks/use-gamepads.ts'
import { useInputMapping } from '#@/pages/library/hooks/use-input-mapping.ts'
import { usePreference } from '#@/pages/library/hooks/use-preference.ts'
import { useRom } from '#@/pages/library/hooks/use-rom.ts'
import { useEmulatorSession } from '../emulator-session-provider.tsx'
import { GameInputMessageItem } from './game-input-message-item.tsx'

export function GameInputMessage() {
  const { t } = useTranslation()
  const { connected } = useGamepads()
  const gamepadMapping = useGamepadMapping()
  const { keyboard: keyboardMapping } = useInputMapping()
  const { preference } = usePreference()
  const { activeEmulator } = useEmulatorSession()
  const rom = useRom()
  const rewindEnabled =
    !activeEmulator?.playlistPlayback && (rom ? preference.emulator.platform[rom.platform].rewindEnabled : true)

  const messages: { keyNames: string[]; message: ReactNode }[] = connected
    ? [
        { keyNames: gamepadMapping.$pause.split(/\s+\+\s/u), message: t('emulator.pause') },
        ...(rewindEnabled
          ? [{ keyNames: gamepadMapping.$rewind.split(/\s+\+\s/u), message: t('emulator.rewind') }]
          : []),
        { keyNames: gamepadMapping.$fast_forward.split(/\s+\+\s/u), message: t('emulator.fastForward') },
      ]
    : [
        {
          keyNames: [
            compact([
              keyboardMapping.input_player1_up,
              keyboardMapping.input_player1_down,
              keyboardMapping.input_player1_left,
              keyboardMapping.input_player1_right,
            ])
              .map((key) => ({ down: '↓', left: '←', right: '→', up: '↑' })[key] || capitalize(key))
              .join(' '),
          ],
          message: <span className='icon-[mdi--gamepad]' />,
        },
        {
          keyNames: compact([keyboardMapping.input_player1_x]),
          message: <span className='icon-[mdi--gamepad-circle-up]' />,
        },
        {
          keyNames: compact([keyboardMapping.input_player1_y]),
          message: <span className='icon-[mdi--gamepad-circle-left]' />,
        },
        {
          keyNames: compact([keyboardMapping.input_player1_a]),
          message: <span className='icon-[mdi--gamepad-circle-right]' />,
        },
        {
          keyNames: compact([keyboardMapping.input_player1_b]),
          message: <span className='icon-[mdi--gamepad-circle-down]' />,
        },
        { keyNames: compact([keyboardMapping.$pause]), message: t('emulator.pause') },
        ...(rewindEnabled
          ? [{ keyNames: compact([keyboardMapping.input_rewind]), message: t('emulator.rewind') }]
          : []),
        { keyNames: compact([keyboardMapping.input_hold_fast_forward]), message: t('emulator.fastForward') },
      ]

  return messages
    .filter(({ keyNames }) => keyNames.length)
    .map(({ keyNames, message }) => (
      <GameInputMessageItem key={keyNames.join(',')} keyNames={keyNames}>
        {message}
      </GameInputMessageItem>
    ))
}
