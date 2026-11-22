import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { MountedRepairError } from '#@/utils/server/mounted-library-runtime.ts'
import { app as auth } from './routes/auth.ts'
import { app as library } from './routes/library/library.ts'
import { users } from './routes/users.ts'

export const app = new Hono()
  .basePath('api/v1')
  .route('auth', auth)
  .route('users', users)
  .route('', library)

  .onError((error, c) => {
    if (error instanceof MountedRepairError) {
      return c.json({ code: error.code, message: error.message }, error.status)
    }
    if (error instanceof HTTPException) {
      return c.json({ message: error.message }, error.status)
    }
    console.error(error)
    return c.json({ message: error.message || 'Unknown error' }, 500)
  })

export type AppType = typeof app
