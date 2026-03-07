import { Hono } from 'hono'
import type { AppContext } from '../types'
import agents from './agents'
import usersRouter from './users'
import dvm from './dvm'
import content from './content'

const api = new Hono<AppContext>()

// Mount sub-routes
api.route('/agents', agents)
api.route('/users', usersRouter)
api.route('/dvm', dvm)

// Content routes are at the top level (/stats, /activity, /timeline, etc.)
api.route('/', content)

export default api
