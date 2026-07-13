import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { MediaGenerationError, type ModelEndpointFetcher } from '../lib/llm/media-generation'
import {
  cleanupDurableGeneratedMediaUploads,
  DurableMediaStorageError,
  persistDurableGeneratedMedia,
  persistDurableGeneratedMediaList,
  type DurableMediaStorageContext,
} from '../lib/generation/media-storage'

const context: DurableMediaStorageContext = {
  userId: '00000000-0000-4000-8000-000000000001',
  conversationId: '10000000-0000-4000-8000-000000000001',
  generationId: '20000000-0000-4000-8000-000000000001',
  baseUrl: 'https://provider.example/v1',
  apiKey: 'provider-secret',
  authType: 'bearer',
}

type Upload = {
  bucket: string
  path: string
  bytes: Uint8Array
  options: Record<string, unknown>
}

function storageClient(options: {
  uploads?: Upload[]
  uploadError?: { message: string } | null
  publicUrl?: (path: string) => string
  removed?: string[]
  uploadThrows?: Error
  removeError?: { message: string } | null
  cleanupUpserts?: Record<string, unknown>[][]
} = {}): SupabaseClient {
  const uploads = options.uploads ?? []
  return {
    from: () => ({
      upsert: async (rows: Record<string, unknown>[]) => {
        options.cleanupUpserts?.push(rows)
        return { data: null, error: null }
      },
    }),
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, bytes: Uint8Array, uploadOptions: Record<string, unknown>) => {
          uploads.push({ bucket, path, bytes, options: uploadOptions })
          if (options.uploadThrows) throw options.uploadThrows
          return { data: null, error: options.uploadError ?? null }
        },
        getPublicUrl: (path: string) => ({
          data: {
            publicUrl: options.publicUrl?.(path)
              ?? `https://project.supabase.co/storage/v1/object/public/generated-media/${path}`,
          },
        }),
        remove: async (paths: string[]) => {
          options.removed?.push(...paths)
          return { data: [], error: options.removeError ?? null }
        },
      }),
    },
  } as unknown as SupabaseClient
}

function dependencies(client: SupabaseClient, extra: Record<string, unknown> = {}) {
  return {
    createAdminClient: () => client,
    randomUUID: () => 'asset-1',
    ...extra,
  }
}

test('uploads validated data media with a user/conversation/generation scoped key', async () => {
  const uploads: Upload[] = []
  const result = await persistDurableGeneratedMedia(context, {
    type: 'image',
    url: 'data:image/png;base64,AQID',
    mimeType: 'image/png',
    alt: 'small image',
  }, dependencies(storageClient({ uploads })))

  assert.equal(uploads.length, 1)
  assert.equal(uploads[0].bucket, 'generated-media')
  assert.equal(uploads[0].path, '00000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000001/asset-1.png')
  assert.deepEqual([...uploads[0].bytes], [1, 2, 3])
  assert.deepEqual(uploads[0].options, {
    contentType: 'image/png',
    cacheControl: '31536000',
    upsert: false,
  })
  assert.deepEqual(result, {
    media: {
      type: 'image',
      url: '/api/v1/media/00000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000001/asset-1.png/content',
      mimeType: 'image/png',
      alt: 'small image',
    },
    receipt: {
      bucket: 'generated-media',
      objectKey: '00000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000001/asset-1.png',
    },
  })
})

test('downloads same-origin media with provider auth and never follows redirects', async () => {
  let request: { url: string; authorization: string; redirect?: RequestRedirect } | undefined
  const fetcher: ModelEndpointFetcher = async (input, init) => {
    request = {
      url: input.toString(),
      authorization: new Headers(init?.headers).get('authorization') ?? '',
      redirect: init?.redirect,
    }
    return new Response(new Uint8Array([4, 5]), {
      headers: { 'Content-Type': 'image/webp', 'Content-Length': '2' },
    })
  }
  const result = await persistDurableGeneratedMedia(context, {
    type: 'image',
    url: 'https://provider.example/assets/result.webp',
  }, dependencies(storageClient(), { fetcher }))

  assert.deepEqual(request, {
    url: 'https://provider.example/assets/result.webp',
    authorization: 'Bearer provider-secret',
    redirect: 'manual',
  })
  assert.equal(result.media.mimeType, 'image/webp')
  assert.match(result.media.url, /asset-1\.webp\/content$/)
})

test('forces stable cross-origin CDN media through download without provider credentials', async () => {
  let credentials: string[] = ['not-called']
  const fetcher: ModelEndpointFetcher = async (_input, init) => {
    const headers = new Headers(init?.headers)
    credentials = ['authorization', 'x-api-key', 'api-key']
      .map(name => headers.get(name) ?? '')
    return new Response(new Uint8Array([6, 7]), {
      headers: { 'Content-Type': 'video/mp4' },
    })
  }
  await persistDurableGeneratedMedia(context, {
    type: 'video',
    url: 'https://result.cloudfront.net/generated/clip.mp4',
  }, dependencies(storageClient(), { fetcher }))
  assert.deepEqual(credentials, ['', '', ''])
})

test('rejects redirects, unsupported MIME and oversized responses before upload', async t => {
  for (const scenario of [
    {
      name: 'redirect',
      response: new Response(null, { status: 302, headers: { Location: 'https://other.example/file.png' } }),
      code: 'redirect_blocked',
    },
    {
      name: 'MIME',
      response: new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }),
      code: 'invalid_media',
    },
    {
      name: 'size',
      response: new Response(new Uint8Array([1]), {
        headers: { 'Content-Type': 'image/png', 'Content-Length': String(12 * 1024 * 1024) },
      }),
      code: 'response_too_large',
    },
  ]) {
    await t.test(scenario.name, async () => {
      const uploads: Upload[] = []
      await assert.rejects(
        persistDurableGeneratedMedia(context, {
          type: 'image',
          url: 'https://provider.example/result.png',
        }, dependencies(storageClient({ uploads }), {
          fetcher: async () => scenario.response,
        })),
        (error: unknown) => error instanceof MediaGenerationError && error.code === scenario.code,
      )
      assert.equal(uploads.length, 0)
    })
  }
})

test('enforces the generated-media bucket size ceiling before upload', async () => {
  const uploads: Upload[] = []
  const encoded = Buffer.alloc(10 * 1024 * 1024 + 1, 1).toString('base64')
  await assert.rejects(
    persistDurableGeneratedMedia(context, {
      type: 'image',
      url: `data:image/png;base64,${encoded}`,
    }, dependencies(storageClient({ uploads }))),
    (error: unknown) => error instanceof DurableMediaStorageError
      && error.code === 'media_too_large',
  )
  assert.equal(uploads.length, 0)
})

test('rejects explicit private media URLs before calling the downloader', async () => {
  let fetchCalls = 0
  await assert.rejects(
    persistDurableGeneratedMedia(context, {
      type: 'image',
      url: 'http://127.0.0.1/admin.png',
    }, dependencies(storageClient(), {
      fetcher: async () => {
        fetchCalls += 1
        return new Response()
      },
    })),
    (error: unknown) => error instanceof DurableMediaStorageError
      && error.code === 'unsafe_media_url',
  )
  assert.equal(fetchCalls, 0)
})

test('fails closed without a service-role client and on storage upload errors', async () => {
  await assert.rejects(
    persistDurableGeneratedMedia(context, {
      type: 'image',
      url: 'data:image/png;base64,AQID',
    }, { createAdminClient: () => null }),
    (error: unknown) => error instanceof DurableMediaStorageError
      && error.code === 'admin_unavailable',
  )

  await assert.rejects(
    persistDurableGeneratedMedia(context, {
      type: 'image',
      url: 'data:image/png;base64,AQID',
    }, dependencies(storageClient({ uploadError: { message: 'storage down' } }))),
    (error: unknown) => error instanceof DurableMediaStorageError
      && error.code === 'upload_failed',
  )
})

test('best-effort cleans an object when upload throws after a possible write', async () => {
  const removed: string[] = []
  await assert.rejects(
    persistDurableGeneratedMedia(context, {
      type: 'image',
      url: 'data:image/png;base64,AQID',
    }, dependencies(storageClient({
      uploadThrows: new Error('connection reset after write'),
      removed,
    }))),
    (error: unknown) => error instanceof DurableMediaStorageError
      && error.code === 'upload_failed',
  )
  assert.deepEqual(removed, ['00000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000001/asset-1.png'])
})

test('rejects unsafe scope segments and never asks Storage for a public URL', async () => {
  await assert.rejects(
    persistDurableGeneratedMedia({ ...context, conversationId: '../other-user' }, {
      type: 'image',
      url: 'data:image/png;base64,AQID',
    }, dependencies(storageClient())),
    (error: unknown) => error instanceof DurableMediaStorageError
      && error.code === 'invalid_scope',
  )

  const result = await persistDurableGeneratedMedia(context, {
    type: 'image',
    url: 'data:image/png;base64,AQID',
  }, dependencies(storageClient({ publicUrl: () => { throw new Error('public URL must not be read') } })))
  assert.match(result.media.url, /^\/api\/v1\/media\//)
})

test('production receipts persist an absolute HTTPS application-proxy URL', async () => {
  const result = await persistDurableGeneratedMedia(context, {
    type: 'image',
    url: 'data:image/png;base64,AQID',
  }, dependencies(storageClient(), {
    publicAppUrl: () => 'https://chat.example/a/path-that-must-not-leak',
  }))
  assert.equal(result.media.url,
    'https://chat.example/api/v1/media/00000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000001/asset-1.png/content')
})

test('production fails closed and removes the upload without an HTTPS proxy origin', {
  concurrency: false,
}, async () => {
  const setEnvironment = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  const prior = {
    nodeEnv: process.env.NODE_ENV,
    publicAppUrl: process.env.PUBLIC_APP_URL,
    agentPublicUrl: process.env.AGENT_PUBLIC_URL,
  }
  const removed: string[] = []
  try {
    setEnvironment('NODE_ENV', 'production')
    setEnvironment('PUBLIC_APP_URL', undefined)
    setEnvironment('AGENT_PUBLIC_URL', undefined)
    await assert.rejects(
      persistDurableGeneratedMedia(context, {
        type: 'image',
        url: 'data:image/png;base64,AQID',
      }, dependencies(storageClient({ removed }))),
      (error: unknown) => error instanceof DurableMediaStorageError
        && error.code === 'invalid_storage_url',
    )
    assert.deepEqual(removed, [
      '00000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000001/asset-1.png',
    ])
  } finally {
    setEnvironment('NODE_ENV', prior.nodeEnv)
    setEnvironment('PUBLIC_APP_URL', prior.publicAppUrl)
    setEnvironment('AGENT_PUBLIC_URL', prior.agentPublicUrl)
  }
})

test('persists media lists in order', async () => {
  let asset = 0
  const result = await persistDurableGeneratedMediaList(context, [
    { type: 'image', url: 'data:image/png;base64,AQ==' },
    { type: 'video', url: 'data:video/mp4;base64,Ag==' },
  ], {
    createAdminClient: () => storageClient(),
    randomUUID: () => `asset-${++asset}`,
  })
  assert.match(result.media[0].url, /asset-1\.png\/content$/)
  assert.match(result.media[1].url, /asset-2\.mp4\/content$/)
  assert.deepEqual(result.receipts.map(receipt => receipt.objectKey), [
    '00000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000001/asset-1.png',
    '00000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000001/asset-2.mp4',
  ])
})

test('cleanup is scope-bound, deduplicated and idempotent', async () => {
  const removed: string[] = []
  const client = storageClient({ removed })
  const receipt = {
    bucket: 'generated-media' as const,
    objectKey: '00000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000001/asset-1.png',
  }
  await cleanupDurableGeneratedMediaUploads(context, [receipt, receipt], {
    createAdminClient: () => client,
  })
  await cleanupDurableGeneratedMediaUploads(context, [receipt], {
    createAdminClient: () => client,
  })
  assert.deepEqual(removed, [receipt.objectKey, receipt.objectKey])

  await assert.rejects(
    cleanupDurableGeneratedMediaUploads(context, [{
      ...receipt,
      objectKey: '00000000-0000-4000-8000-000000000002/10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000001/asset-1.png',
    }], { createAdminClient: () => client }),
    (error: unknown) => error instanceof DurableMediaStorageError
      && error.code === 'invalid_receipt',
  )
})

test('cleanup failure is durably queued for a later retry', async () => {
  const cleanupUpserts: Record<string, unknown>[][] = []
  const receipt = {
    bucket: 'generated-media' as const,
    objectKey: '00000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000001/asset-1.png',
  }
  await assert.rejects(
    cleanupDurableGeneratedMediaUploads(context, [receipt], {
      createAdminClient: () => storageClient({
        removeError: { message: 'storage unavailable' },
        cleanupUpserts,
      }),
    }),
    (error: unknown) => error instanceof DurableMediaStorageError
      && error.code === 'cleanup_failed',
  )
  assert.equal(cleanupUpserts.length, 1)
  assert.equal(cleanupUpserts[0][0].object_key, receipt.objectKey)
  assert.equal(cleanupUpserts[0][0].reason, 'orphan_upload')
  assert.equal(cleanupUpserts[0][0].completed_at, null)
})

test('rolls back earlier uploads when a media batch fails', async () => {
  const removed: string[] = []
  const client = storageClient({ removed })
  await assert.rejects(
    persistDurableGeneratedMediaList(context, [
      { type: 'image', url: 'data:image/png;base64,AQ==' },
      { type: 'image', url: 'http://127.0.0.1/private.png' },
    ], dependencies(client)),
    (error: unknown) => error instanceof DurableMediaStorageError
      && error.code === 'unsafe_media_url',
  )
  assert.deepEqual(removed, ['00000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000001/asset-1.png'])
})
