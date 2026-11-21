import { clsx } from 'clsx'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { twMerge } from 'tailwind-merge'
import { useEmulatorLaunched } from '#@/pages/library/atoms.ts'
import { useGamepads } from '#@/pages/library/hooks/use-gamepads.ts'
import { usePreference } from '#@/pages/library/hooks/use-preference.ts'
import { useRom } from '#@/pages/library/hooks/use-rom.ts'
import { useEmulatorSession } from '../emulator-session-provider.tsx'
import { useEmulator } from '../hooks/use-emulator.ts'
import { useGameOverlay } from '../hooks/use-game-overlay.ts'
import { VirtualGamepadButton } from './virtual-gamepad-button.tsx'

type HoldCommand = 'FAST_FORWARD_HOLD' | 'REWIND'

async function waitForAnimationFrame() {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve())
  })
}

interface VirtualGamepadCommandButtonProps {
  children: ReactNode
  className?: string
  command: HoldCommand
  title: string
}

function VirtualGamepadCommandButton({
  children,
  className,
  command,
  title,
}: Readonly<VirtualGamepadCommandButtonProps>) {
  const { emulator } = useEmulator()
  const commandLoop = useRef<Promise<void> | undefined>(undefined)
  const pressing = useRef(false)

  async function runCommandLoop() {
    while (pressing.current) {
      await waitForAnimationFrame()
      if (pressing.current) {
        emulator?.sendCommand(command)
      }
    }
  }

  function handleVirtualPressStart() {
    if (pressing.current) {
      return
    }

    pressing.current = true
    commandLoop.current = runCommandLoop()
  }

  function handleVirtualPressEnd() {
    pressing.current = false
  }

  useEffect(
    () => () => {
      pressing.current = false
    },
    [],
  )

  return (
    <VirtualGamepadButton
      className={className}
      onVirtualPressEnd={handleVirtualPressEnd}
      onVirtualPressStart={handleVirtualPressStart}
      title={title}
    >
      {children}
    </VirtualGamepadButton>
  )
}

export function GameOverlayVirtualGamepad() {
  const { connected } = useGamepads()
  const [gamepadVisible, setGamepadVisible] = useState(!connected)
  const { show } = useGameOverlay()
  const [launched] = useEmulatorLaunched()
  const rom = useRom()
  const { preference } = usePreference()
  const { activeEmulator } = useEmulatorSession()
  const rewindEnabled =
    !activeEmulator?.playlistPlayback &&
    !activeEmulator?.inGameSave &&
    (rom ? preference.emulator.platform[rom.platform].rewindEnabled : true)

  if (!launched) {
    return
  }

  return (
    <div className='fixed inset-0 block touch-none lg:hidden'>
      <div className='top-safe p-x-2 absolute inset-x-0 flex'>
        <VirtualGamepadButton
          className={twMerge('left-safe absolute rounded p-2', clsx({ hidden: !gamepadVisible }))}
          onClick={async () => await show()}
        >
          <span className='icon-[mdi--pause]' />
        </VirtualGamepadButton>

        <VirtualGamepadButton
          className='right-safe absolute rounded p-2'
          onClick={() => setGamepadVisible(!gamepadVisible)}
          title='Toggle gamepad'
        >
          <span className='icon-[mdi--gamepad-square]' />
        </VirtualGamepadButton>
      </div>

      <div
        className={twMerge('bottom-safe left-safe absolute flex flex-col gap-2 p-2', clsx({ hidden: !gamepadVisible }))}
      >
        {rewindEnabled ? (
          <VirtualGamepadCommandButton className='rounded px-2 py-1 ring ring-white/20' command='REWIND' title='Rewind'>
            <span className='icon-[mdi--rewind] size-6' />
          </VirtualGamepadCommandButton>
        ) : null}
        <div className='flex w-full gap-2'>
          <VirtualGamepadButton buttonName='l' className='flex-1 rounded px-2 py-1 ring ring-white/20'>
            L1
          </VirtualGamepadButton>
          <VirtualGamepadButton buttonName='l2' className='flex-1 rounded px-2 py-1 ring ring-white/20'>
            L2
          </VirtualGamepadButton>
        </div>
        <div className='relative size-42 overflow-hidden rounded-xl ring ring-white/20'>
          <VirtualGamepadButton
            buttonNames={['up', 'left']}
            className='absolute top-0 left-0 size-14 rounded-tl-xl ring-1 ring-white/10'
            title='up,left'
          >
            <span className='icon-[mdi--arrow-up-left-thick]' />
          </VirtualGamepadButton>
          <VirtualGamepadButton
            buttonName='up'
            className='absolute top-0 left-14 h-21 w-14 [clip-path:polygon(0_0,100%_0,100%_66.6667%,50%_100%,0_66.6667%)]'
            title='up'
          >
            <span className='pointer-events-none absolute top-0 left-0 flex size-14 items-center justify-center'>
              <span className='icon-[mdi--arrow-up-thick]' />
            </span>
          </VirtualGamepadButton>
          <VirtualGamepadButton
            buttonNames={['right', 'up']}
            className='absolute top-0 right-0 size-14 rounded-tr-xl ring-1 ring-white/10'
            title='right,up'
          >
            <span className='icon-[mdi--arrow-top-right-thick]' />
          </VirtualGamepadButton>
          <VirtualGamepadButton
            buttonName='left'
            className='absolute top-14 left-0 h-14 w-21 [clip-path:polygon(0_0,66.6667%_0,100%_50%,66.6667%_100%,0_100%)]'
            title='left'
          >
            <span className='pointer-events-none absolute top-0 left-0 flex size-14 items-center justify-center'>
              <span className='icon-[mdi--arrow-left-thick]' />
            </span>
          </VirtualGamepadButton>
          <VirtualGamepadButton
            buttonName='right'
            className='absolute top-14 right-0 h-14 w-21 [clip-path:polygon(33.3333%_0,100%_0,100%_100%,33.3333%_100%,0_50%)]'
            title='right'
          >
            <span className='pointer-events-none absolute top-0 right-0 flex size-14 items-center justify-center'>
              <span className='icon-[mdi--arrow-right-thick]' />
            </span>
          </VirtualGamepadButton>
          <VirtualGamepadButton
            buttonNames={['left', 'down']}
            className='absolute bottom-0 left-0 size-14 rounded-bl-xl ring-1 ring-white/10'
            title='left,down'
          >
            <span className='icon-[mdi--arrow-bottom-left-thick]' />
          </VirtualGamepadButton>
          <VirtualGamepadButton
            buttonName='down'
            className='absolute bottom-0 left-14 h-21 w-14 [clip-path:polygon(50%_0,100%_33.3333%,100%_100%,0_100%,0_33.3333%)]'
            title='down'
          >
            <span className='pointer-events-none absolute bottom-0 left-0 flex size-14 items-center justify-center'>
              <span className='icon-[mdi--arrow-bottom-thick]' />
            </span>
          </VirtualGamepadButton>
          <VirtualGamepadButton
            buttonNames={['right', 'down']}
            className='absolute right-0 bottom-0 size-14 rounded-br-xl ring-1 ring-white/10'
            title='right,down'
          >
            <span className='icon-[mdi--arrow-bottom-right-thick]' />
          </VirtualGamepadButton>
        </div>
        <VirtualGamepadButton buttonName='select' className='rounded py-1 text-xs ring ring-white/20'>
          <span className='icon-[mdi--menu]' />
          Select
        </VirtualGamepadButton>
      </div>

      <div
        className={twMerge(
          'bottom-safe right-safe absolute flex flex-col gap-2 p-2',
          clsx({ hidden: !gamepadVisible }),
        )}
      >
        <VirtualGamepadCommandButton
          command='FAST_FORWARD_HOLD'
          className='rounded px-2 py-1 ring ring-white/20'
          title='Fast forward'
        >
          <span className='icon-[mdi--fast-forward] size-6' />
        </VirtualGamepadCommandButton>
        <div className='flex w-full gap-2'>
          <VirtualGamepadButton buttonName='r2' className='flex-1 rounded px-2 py-1 ring ring-white/20'>
            R2
          </VirtualGamepadButton>
          <VirtualGamepadButton buttonName='r' className='flex-1 rounded px-2 py-1 ring ring-white/20'>
            R1
          </VirtualGamepadButton>
        </div>
        <div className='grid grid-cols-3 grid-rows-3 *:size-14 *:rounded-full'>
          <VirtualGamepadButton buttonName='x' className='col-start-2 row-start-1 ring ring-white/20'>
            X
          </VirtualGamepadButton>
          <VirtualGamepadButton buttonName='y' className='col-start-1 row-start-2 ring ring-white/20'>
            Y
          </VirtualGamepadButton>
          <VirtualGamepadButton buttonName='a' className='col-start-3 row-start-2 ring ring-white/20'>
            A
          </VirtualGamepadButton>
          <VirtualGamepadButton buttonName='b' className='col-start-2 row-start-3 ring ring-white/20'>
            B
          </VirtualGamepadButton>
        </div>
        <VirtualGamepadButton buttonName='start' className='rounded py-1 text-xs ring ring-white/20'>
          <span className='icon-[mdi--play]' /> Start
        </VirtualGamepadButton>
      </div>
    </div>
  )
}
