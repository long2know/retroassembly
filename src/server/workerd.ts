import { Hono } from 'hono'
import { RouterContextProvider, createRequestHandler } from 'react-router'
import { configureRouterBuild } from '#@/utils/server/router-build.ts'
import app from './app.ts'

async function getBuild() {
  return configureRouterBuild(await import('virtual:react-router/server-build'), '/')
}

const pages = new Hono()
const requestHandler = createRequestHandler(getBuild, import.meta.env.MODE)
pages.all('*', (c) => requestHandler(c.req.raw, new RouterContextProvider()))

app.route('', pages)

export { default } from './app.ts'
