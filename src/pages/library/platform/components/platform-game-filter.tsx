import { IconButton, TextField } from '@radix-ui/themes'
import { useEffect, useEffectEvent, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { NavigationType, useHref, useLocation, useNavigate, useNavigation, useNavigationType } from 'react-router'
import {
  normalizePlatformGameFilter,
  platformGameFilterMaxLength,
  platformGameFilterParam,
} from '#@/utils/isomorphic/platform-game-filter.ts'
import { useIsApple } from '../../hooks/use-is-apple.ts'

function getFilter(search: string) {
  return normalizePlatformGameFilter(new URLSearchParams(search).get(platformGameFilterParam))
}

export function PlatformGameFilter({ gameFilter }: Readonly<{ gameFilter: string }>) {
  const { t } = useTranslation()
  const isApple = useIsApple()
  const input = useRef<HTMLInputElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const editId = useId()
  const location = useLocation()
  const platformHref = useHref(location.pathname)
  const navigation = useNavigation()
  const navigationType = useNavigationType()
  const navigate = useNavigate()
  const [draft, setDraft] = useState(gameFilter)
  const [composing, setComposing] = useState(false)
  const [previousLocation, setPreviousLocation] = useState(location)

  if (previousLocation.key !== location.key) {
    setPreviousLocation(location)
    // Restore history entries without overwriting newer typing when a filter request finishes.
    if (
      navigationType === NavigationType.Pop ||
      (location.state?.platformGameFilter !== editId && getFilter(previousLocation.search) !== gameFilter)
    ) {
      setDraft(gameFilter)
    }
  }

  async function applyFilter(value: string) {
    const nextLocation = navigation.location ?? location
    if (nextLocation.pathname !== location.pathname && nextLocation.pathname !== platformHref) {
      return
    }
    const filter = normalizePlatformGameFilter(value)
    if (filter === getFilter(nextLocation.search)) {
      return
    }

    const params = new URLSearchParams(nextLocation.search)
    if (filter) {
      params.set(platformGameFilterParam, filter)
    } else {
      params.delete(platformGameFilterParam)
    }
    params.delete('page')
    await navigate(
      { hash: nextLocation.hash, search: params.toString() },
      { preventScrollReset: true, replace: true, state: { platformGameFilter: editId } },
    )
  }

  const applyDebouncedFilter = useEffectEvent(applyFilter)
  useEffect(() => {
    if (!composing) {
      const timeout = setTimeout(async () => {
        await applyDebouncedFilter(draft)
      }, 250)
      timer.current = timeout
      return () => clearTimeout(timeout)
    }
  }, [composing, draft])

  async function clearFilter() {
    clearTimeout(timer.current)
    input.current?.focus()
    setDraft('')
    await applyFilter('')
  }

  const handleKeyDown = useEffectEvent(async (event: KeyboardEvent) => {
    const isComposing = composing || event.isComposing
    if (!isComposing && (isApple ? event.metaKey : event.ctrlKey) && event.key.toLowerCase() === 'k') {
      return
    }
    event.stopPropagation()
    if (event.key === 'Escape' && !isComposing) {
      event.preventDefault()
      await clearFilter()
    }
  })

  useEffect(() => {
    // React delegates events to the document, where spatial and global navigation also listen.
    const abortController = new AbortController()
    input.current?.addEventListener('keydown', handleKeyDown, { signal: abortController.signal })
    return () => abortController.abort()
  }, [])

  const label = t('platformFilter.label')

  return (
    <div className='lg:px-4'>
      <TextField.Root
        aria-label={label}
        autoComplete='off'
        className='w-full sm:max-w-72'
        inputMode='search'
        maxLength={platformGameFilterMaxLength}
        onChange={(event) => {
          clearTimeout(timer.current)
          setDraft(event.currentTarget.value)
        }}
        onCompositionEnd={(event) => {
          setDraft(event.currentTarget.value)
          setComposing(false)
        }}
        onCompositionStart={() => {
          clearTimeout(timer.current)
          setComposing(true)
        }}
        placeholder={label}
        ref={input}
        spellCheck={false}
        value={draft}
      >
        <TextField.Slot>
          <span aria-hidden className='icon-[mdi--magnify] size-4' />
        </TextField.Slot>
        {draft ? (
          <TextField.Slot>
            <IconButton
              aria-label={t('platformFilter.clear')}
              onClick={clearFilter}
              size='1'
              type='button'
              variant='ghost'
            >
              <span aria-hidden className='icon-[mdi--close] size-4' />
            </IconButton>
          </TextField.Slot>
        ) : null}
      </TextField.Root>
    </div>
  )
}
