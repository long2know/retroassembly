export function normalizeBasePath(value: string | undefined) {
  if (!value || value === '/') {
    return '/'
  }
  const basePath = value.endsWith('/') ? value.slice(0, -1) : value
  const segments = basePath.slice(1).split('/')
  if (
    !basePath.startsWith('/') ||
    /[^\w.~/-]/u.test(basePath) ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('BASE_URL must be an absolute path of URL-safe segments, without an origin, query or fragment')
  }
  return basePath
}

export function getBasePath() {
  return normalizeBasePath(
    typeof document === 'undefined' ? globalThis.process?.env.BASE_URL : document.documentElement.dataset.baseUrl,
  )
}

export function stripBasePath(value: string, basePath = getBasePath()) {
  const base = normalizeBasePath(basePath)
  const [pathname = ''] = value.split(/[?#]/u, 1)
  if (!pathname.startsWith('/') || pathname.startsWith('//')) {
    return
  }
  if (base === '/') {
    return value
  }
  if (pathname === base) {
    return `/${value.slice(base.length)}`
  }
  if (pathname.startsWith(`${base}/`)) {
    return value.slice(base.length)
  }
}

export function withBasePath(value: string, basePath = getBasePath()) {
  if (/^(?:[a-z][\w+.-]*:|\/\/|[?#])/iu.test(value)) {
    return value
  }
  const path = value.startsWith('./') ? value.slice(2) : value
  const absolutePath = path.startsWith('/') ? path : `/${path}`
  const base = normalizeBasePath(basePath)
  // Application paths can begin with the same segment as the deployment prefix.
  return base === '/' ? absolutePath : `${base}${absolutePath}`
}
