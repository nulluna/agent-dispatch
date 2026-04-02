import { handleDispatchRequest } from './dispatch'
import type { DispatchEnv } from './config'

export default {
  async fetch(request: Request, env: DispatchEnv): Promise<Response> {
    return handleDispatchRequest(request, env)
  },
}
