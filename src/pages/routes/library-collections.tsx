import { getContext } from 'hono/context-storage'
import { data } from 'react-router'
import { getCollectionGames, listCollections } from '#@/controllers/collections/collections.ts'
import { CollectionsPage } from '#@/pages/library/collections/page.tsx'
import { getLibraryLoaderData } from '#@/utils/server/loader-data.ts'
import type { Route } from './+types/library-collections.ts'

export { ErrorPage as ErrorBoundary } from '#@/pages/components/error-page.tsx'

export function headers() {
  return { 'Cache-Control': 'private, no-store' }
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const { currentUser, t } = getContext().var
  if (!currentUser) {
    throw data(null, { headers: headers(), status: 401 })
  }
  if (!params.collectionId) {
    const collections = await listCollections()
    return data(await getLibraryLoaderData({ collections, title: t('nav.collections') }), { headers: headers() })
  }

  const requestedPage = Number(new URL(request.url).searchParams.get('page'))
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1
  const detail = await getCollectionGames(params.collectionId, page)
  if (!detail) {
    throw data(null, { headers: headers(), status: 404 })
  }
  return data(await getLibraryLoaderData({ ...detail, title: detail.collection.name }), { headers: headers() })
}

export default function LibraryCollectionsRoute() {
  return <CollectionsPage />
}
