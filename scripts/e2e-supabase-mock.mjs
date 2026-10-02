import { createServer } from 'node:http'

const host = '127.0.0.1'
const port = 3211
const user = {
  id: '10000000-0000-4000-8000-000000000001',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'architect@example.test',
  email_confirmed_at: '2026-01-01T00:00:00.000Z',
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: {},
  identities: [],
  created_at: '2026-01-01T00:00:00.000Z',
}
const session = {
  access_token: 'e2e-access-token',
  refresh_token: 'e2e-refresh-token',
  token_type: 'bearer',
  expires_in: 86_400,
  expires_at: Math.floor(Date.now() / 1000) + 86_400,
  user,
}

const server = createServer((request, response) => {
  response.setHeader('access-control-allow-origin', '*')
  response.setHeader('access-control-allow-headers', 'authorization, apikey, content-type, prefer, x-client-info')
  response.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS')
  response.setHeader('content-type', 'application/json')

  if (request.method === 'OPTIONS') {
    response.writeHead(204).end()
    return
  }

  const { pathname } = new URL(request.url ?? '/', `http://${host}:${port}`)
  if (pathname === '/health') {
    response.writeHead(200).end(JSON.stringify({ status: 'ok' }))
    return
  }
  if (pathname === '/auth/v1/user') {
    response.writeHead(200).end(JSON.stringify(user))
    return
  }
  if (pathname === '/auth/v1/token') {
    response.writeHead(200).end(JSON.stringify(session))
    return
  }
  if (pathname.startsWith('/rest/v1/')) {
    response.writeHead(200).end('[]')
    return
  }

  response.writeHead(404).end(JSON.stringify({ message: 'E2E Supabase mock route not found' }))
})

server.listen(port, host)
