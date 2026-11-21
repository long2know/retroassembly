import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { collectionNameSchema } from '#@/constants/game-collections.ts'
import {
  addCollectionGame,
  createCollection,
  deleteCollection,
  listCollectionsForRom,
  removeCollectionGame,
  renameCollection,
} from '#@/controllers/collections/collections.ts'

const validateName = zValidator('json', z.object({ name: collectionNameSchema }))

export const collections = new Hono()
  .use(async (c, next) => {
    c.header('Cache-Control', 'private, no-store')
    if (!c.var.currentUser) {
      return c.json({ message: 'Authentication required' }, 401)
    }
    await next()
  })
  .get('for-rom/:romId', async (c) => c.json(await listCollectionsForRom(c.req.param('romId'))))
  .post('', validateName, async (c) => {
    const collection = await createCollection(c.req.valid('json').name)
    return collection ? c.json(collection, 201) : c.json({ code: 'duplicateName' }, 409)
  })
  .patch(':collectionId', validateName, async (c) => {
    const collection = await renameCollection(c.req.param('collectionId'), c.req.valid('json').name)
    return collection ? c.json(collection) : c.json({ code: 'duplicateName' }, 409)
  })
  .delete(':collectionId', async (c) => {
    await deleteCollection(c.req.param('collectionId'))
    return c.json(null)
  })
  .put(':collectionId/roms/:romId', async (c) => {
    await addCollectionGame(c.req.param('collectionId'), c.req.param('romId'))
    return c.json(null)
  })
  .delete(':collectionId/roms/:romId', async (c) => {
    await removeCollectionGame(c.req.param('collectionId'), c.req.param('romId'))
    return c.json(null)
  })
