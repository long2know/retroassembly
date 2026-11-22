import { useLocation, useMatch, useNavigate, useNavigation } from 'react-router'
import { routes } from '#@/pages/routes.ts'
import { platformGameFilterParam } from '#@/utils/isomorphic/platform-game-filter.ts'
import { useSpatialNavigationPaused } from '../atoms.ts'

export function useRouter() {
  const { state } = useNavigation()
  const navigate = useNavigate()
  const location = useLocation()
  const platformPage = useMatch(routes.libraryPlatform)
  const [, setSpatialNavigationPaused] = useSpatialNavigationPaused()

  const isNavigating = state === 'loading'

  async function reload() {
    const params = new URLSearchParams(location.search)
    const hasPlatformFilter = Boolean(platformPage && params.get(platformGameFilterParam))
    if (hasPlatformFilter && params.get('favorite') === '1') {
      params.delete('page')
    }
    await navigate(
      { pathname: location.pathname, search: hasPlatformFilter ? params.toString() : '' },
      { preventScrollReset: hasPlatformFilter, replace: true },
    )
    setSpatialNavigationPaused(false)
  }

  return { isNavigating, reload }
}
