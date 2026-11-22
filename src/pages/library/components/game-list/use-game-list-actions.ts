import { useLoaderData, useLocation } from 'react-router'
import { libraryModeEnum } from '#@/databases/schema.ts'
import { useGlobalLoaderData } from '#@/pages/hooks/use-global-loader-data.ts'
import { routes } from '../../../routes.ts'
import { useIsDemo } from '../../hooks/use-demo.ts'
import { useRoms } from '../../hooks/use-roms.ts'

export function useGameListActions() {
  const { roms } = useRoms()
  const { gameFilter } = useLoaderData<{ gameFilter?: string }>()
  const { pathname, search } = useLocation()
  const isDemo = useIsDemo()
  const { currentUser, env } = useGlobalLoaderData()

  const hasRoms = roms.length > 0
  const isEmptyFilteredGrid = !hasRoms && Boolean(gameFilter)
  const isHistoryPage = pathname === routes.libraryHistory
  const isFavoritesPage = pathname === routes.libraryFavorites
  const isSharedLibrary =
    currentUser?.libraryMode === libraryModeEnum.shared &&
    !roms.some((rom) => 'mountedSource' in rom && rom.mountedSource)
  const shouldHideActions = isDemo || isHistoryPage || (isSharedLibrary && !isEmptyFilteredGrid)
  const isMountedOnly =
    env.RETROASSEMBLY_RUN_TIME_ENABLE_SHARED_ROM_LIBRARY === 'true' &&
    env.RETROASSEMBLY_RUN_TIME_SHARED_LIBRARY_ONLY === 'true'
  const canDeleteUploads = !shouldHideActions && !isMountedOnly && currentUser?.libraryMode === libraryModeEnum.isolated
  const deletableRomIds = new Set(
    canDeleteUploads
      ? roms.filter((rom) => !rom.mountedSource && 'userId' in rom && rom.userId === currentUser.id).map(({ id }) => id)
      : [],
  )

  const searchParams = new URLSearchParams(search)
  const direction = searchParams.get('direction') || 'asc'
  const isViewingFavorites = searchParams.get('favorite') === '1'
  const sort = searchParams.get('sort') || 'name'

  const showSortDropdown = hasRoms || isEmptyFilteredGrid
  const showFavoriteButton = (!isFavoritesPage && showSortDropdown) || isViewingFavorites

  function buildSortLink(params: Record<string, string>) {
    if (gameFilter !== undefined) {
      const newParams = new URLSearchParams(searchParams)
      newParams.delete('page')
      for (const [key, value] of Object.entries(params)) {
        newParams.set(key, value)
      }
      return [pathname, newParams].join('?')
    }
    const newParams = new URLSearchParams(params)
    if (isViewingFavorites) {
      newParams.set('favorite', '1')
    }
    return [pathname, newParams].join('?')
  }

  function getFavoriteToggleLink() {
    const params = new URLSearchParams(search)
    if (gameFilter !== undefined) {
      params.delete('page')
    }
    if (isViewingFavorites) {
      params.delete('favorite')
    } else {
      params.set('favorite', '1')
    }
    const query = params.toString()
    return query ? [pathname, query].join('?') : pathname
  }

  return {
    buildSortLink,
    deletableRomIds,
    direction,
    getFavoriteToggleLink,
    hasRoms,
    isDemo,
    isViewingFavorites,
    pathname,
    roms,
    search,
    shouldHideActions,
    showFavoriteButton,
    showSortDropdown,
    sort,
  }
}
