export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status })
}
