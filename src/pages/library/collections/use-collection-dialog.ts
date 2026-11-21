import { useEffect, useState } from 'react'
import { useSpatialNavigationPaused } from '../atoms.ts'

export function useCollectionDialog() {
  const [open, setOpen] = useState(false)
  const [, setSpatialNavigationPaused] = useSpatialNavigationPaused()

  useEffect(() => {
    if (open) {
      setSpatialNavigationPaused(true)
      return () => setSpatialNavigationPaused(false)
    }
  }, [open, setSpatialNavigationPaused])

  return { open, setOpen }
}
