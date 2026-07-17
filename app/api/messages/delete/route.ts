import { NextRequest } from 'next/server'
import { handleMessageDeletion } from '@/lib/api/message-deletion'

export async function POST(request: NextRequest) {
  return handleMessageDeletion(request)
}
