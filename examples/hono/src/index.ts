import { Hono } from 'hono'
import { createHandler } from '@vercel/slack-bolt'
import { app as boltApp, receiver } from './bolt/app.js'

const handler = createHandler(boltApp, receiver)

const app = new Hono()



app.post('/api/events', async (c) => {
  return await handler(c.req.raw)
})

export default app
