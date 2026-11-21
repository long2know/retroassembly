import { Nostalgist } from 'nostalgist'
import {
  isCompatiblePlaylistState,
  type MountedPlaylist,
  type MountedPlaylistState,
} from '#@/constants/mounted-library.ts'
import { withBasePath } from '#@/utils/isomorphic/base-url.ts'

type Options = Parameters<typeof Nostalgist.prepare>[0]
type CoreLog = Parameters<NonNullable<Options['onLog']>>[0]
type Observe = (log: CoreLog) => boolean | undefined

const contentDirectory = '/home/web_user/retroarch/userdata/content'

function discName(index: number) {
  return `disc-${index}.chd`
}

// The pinned RetroArch 1.22.2 Emscripten build has no locale driver, so its messages stay in English.
function observeDisc(index: number, count: number, isSwitch: boolean): Observe {
  let ejected = !isSwitch
  let loaded = false
  let selected = false
  return function observe({ message, source }) {
    if (source === 'core' && message.startsWith('Loaded CD Image: ')) {
      loaded = message.includes(`/${discName(index)}[+chd]`)
    } else if (message === '[Disc] Ejected virtual disc tray.') {
      ejected = true
    } else if (message === `[Disc] Setting disc in tray: ${index}/${count} - disc-${index}`) {
      selected = true
      if (!isSwitch) {
        return loaded
      }
    } else if (message === '[Disc] Closed virtual disc tray.') {
      return ejected && loaded && selected
    } else if (message.startsWith('[Disc] Failed to ')) {
      return false
    }
  }
}

export async function prepareMountedPlaylist(options: Options, romId: string, playlist: MountedPlaylist) {
  const lifecycle = new AbortController()
  const count = playlist.discs.length
  const listeners = new Set<() => void>()
  let activeDisc: number | undefined
  let busy = false
  let started = false
  let observer: ((log: CoreLog) => void) | undefined

  function setDisc(index: number | undefined) {
    activeDisc = index
    for (const listener of listeners) {
      listener()
    }
  }

  async function fetchDisc(index: number, method: 'GET' | 'HEAD') {
    const url = withBasePath(`/api/v1/roms/${encodeURIComponent(romId)}/discs/${index}`)
    const response = await fetch(`${url}?${new URLSearchParams({ revision: playlist.revision })}`, {
      cache: 'no-store',
      credentials: 'same-origin',
      method,
      signal: lifecycle.signal,
    })
    if (!response.ok) {
      throw new Error(`Mounted disc ${index} is not available (${response.status})`)
    }
    return response
  }

  const names = playlist.discs.map((_disc, index) => discName(index + 1))
  const emulator = await Nostalgist.prepare({
    ...options,
    onLog(log) {
      if (observer) {
        observer(log)
      } else if (/^\[Disc\] (?:Ejected|Closed) |^switching to disk /u.test(log.message)) {
        setDisc(undefined)
      }
    },
    retroarchConfig: {
      ...options.retroarchConfig,
      frontend_log_level: 1,
      input_disk_eject_toggle: 'nul',
      input_disk_next: 'nul',
      // @ts-expect-error Nostalgist 0.23.0 omits this RetroArch binding from its config type.
      input_disk_prev: 'nul',
      libretro_log_level: 1,
      log_verbosity: true,
      rewind_enable: false,
    },
    rom: [
      { fileContent: new Blob([`${names.join('\n')}\n`]), fileName: 'game.m3u' },
      ...names.map((fileName, index) => ({ fileContent: () => fetchDisc(index + 1, 'GET'), fileName })),
    ],
    state: undefined,
  })
  async function exclusive<T>(operation: () => Promise<T>) {
    lifecycle.signal.throwIfAborted()
    if (busy) {
      throw new Error('Another playlist operation is in progress')
    }
    busy = true
    try {
      return await operation()
    } finally {
      busy = false
    }
  }

  // Nostalgist resolves after queuing commands; wait for this pinned core to report the result.
  async function confirm(action: () => void | Promise<void>, observe: Observe) {
    const ready = Promise.withResolvers<boolean>()
    let outcome: boolean | undefined
    function fail() {
      outcome = false
      ready.resolve(false)
    }
    observer = (log) => {
      const result = observe(log)
      if (result !== undefined && outcome !== false) {
        outcome = result
        ready.resolve(result)
      }
    }
    lifecycle.signal.addEventListener('abort', fail, { once: true })
    try {
      await action()
      const deadline = setTimeout(fail, 5000)
      try {
        await ready.promise
        if (!outcome) {
          throw new Error('PlayStation core did not confirm the command')
        }
      } finally {
        clearTimeout(deadline)
      }
    } finally {
      lifecycle.signal.removeEventListener('abort', fail)
      observer = undefined
    }
  }

  async function stageDiscChange(from: number, to: number) {
    const step = Math.sign(to - from)
    const pendingImages = emulator.getEmulatorOptions().multiDiscRom
    if (!pendingImages) {
      throw new Error('PlayStation core did not prepare a playlist')
    }
    // The core must open each intermediate slot, even while the tray is ejected.
    for (let index = from + step; index !== to + step; index += step) {
      if (pendingImages.has(index)) {
        const response = await fetchDisc(index, 'GET')
        const bytes = new Uint8Array(await response.arrayBuffer())
        emulator.getEmscriptenFS().writeFile(`${contentDirectory}/${discName(index)}`, bytes)
        pendingImages.delete(index)
      } else if (index !== to) {
        await fetchDisc(index, 'HEAD')
      }
    }
  }

  async function toggleTray(acknowledgement: string) {
    await confirm(
      () => emulator.sendCommand('DISK_EJECT_TOGGLE'),
      ({ message }) => {
        if (message === acknowledgement) {
          return true
        }
        if (message.startsWith('[Disc] Failed to ')) {
          return false
        }
      },
    )
  }

  async function jumpDisc(from: number, to: number) {
    const step = Math.sign(to - from)
    const command = step > 0 ? 'DISK_NEXT' : 'DISK_PREV'
    await toggleTray('[Disc] Ejected virtual disc tray.')
    // RetroArch coalesces repeated commands queued in a single frame.
    for (let index = from + step; index !== to + step; index += step) {
      await confirm(() => emulator.sendCommand(command), observeDisc(index, count, false))
    }
    await toggleTray('[Disc] Closed virtual disc tray.')
    emulator.getEmulatorOptions().multiDiscIndex = to
  }

  async function select(index: number) {
    const previous = activeDisc
    if (!previous || !Number.isInteger(index) || index < 1 || index > count) {
      throw new Error('No confirmed disc or invalid disc number')
    }
    await fetchDisc(index, 'HEAD')
    const jump = Math.abs(index - previous) > 1
    if (previous !== index) {
      await stageDiscChange(previous, index)
    }
    lifecycle.signal.throwIfAborted()
    if (activeDisc !== previous) {
      throw new Error('The active disc changed during verification')
    }
    if (previous !== index) {
      try {
        await (jump
          ? jumpDisc(previous, index)
          : confirm(() => emulator.switchDisc(index), observeDisc(index, count, true)))
        setDisc(index)
      } catch (error) {
        setDisc(undefined)
        throw error
      }
    }
  }

  async function restore(fileUrl: string, state: MountedPlaylistState) {
    if (!isCompatiblePlaylistState(playlist, state)) {
      throw new Error('The saved state belongs to another playlist revision')
    }
    await select(state.disc)
    const response = await fetch(fileUrl, { credentials: 'same-origin', signal: lifecycle.signal })
    if (!response.ok) {
      throw new Error('Could not fetch playlist state')
    }
    const blob = await response.blob()
    await confirm(
      () => emulator.loadState(blob),
      ({ message }) => {
        if (/^\[State\] Failed to load|^Failed to load state/u.test(message)) {
          return false
        }
        if (message.startsWith('switching to disk ')) {
          setDisc(undefined)
          return false
        }
        if (message.startsWith('[State] Loading state ')) {
          return true
        }
      },
    )
  }

  return {
    emulator,
    playlistPlayback: {
      close() {
        lifecycle.abort()
      },
      getDisc: () => activeDisc,
      hasStarted: () => started,
      loadState: (url: string, state: MountedPlaylistState) => exclusive(() => restore(url, state)),
      playlist,
      saveState: () =>
        exclusive(async () => {
          if (!activeDisc) {
            throw new Error('No confirmed disc for the saved state')
          }
          const result = await emulator.saveState()
          if (result.multiDiscIndex !== activeDisc) {
            throw new Error('Saved state disc did not match the confirmed disc')
          }
          return result
        }),
      select: (index: number) => exclusive(() => select(index)),
      start: (resume?: { state: MountedPlaylistState; url: string }) =>
        exclusive(async () => {
          await fetchDisc(1, 'HEAD')
          await confirm(() => emulator.start(), observeDisc(1, count, false))
          setDisc(1)
          if (resume) {
            await restore(resume.url, resume.state)
          }
          started = true
        }),
      subscribe(listener: () => void) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  }
}

export type PlaylistPlayback = Awaited<ReturnType<typeof prepareMountedPlaylist>>['playlistPlayback']
