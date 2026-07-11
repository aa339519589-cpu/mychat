import test from "node:test"
import assert from "node:assert/strict"
import dns from "node:dns/promises"
import { createServer } from "node:http"
import { once } from "node:events"
import {
  combineMediaGenerationSignals,
  generateOpenAICompatibleImage,
  generateOpenAICompatibleMedia,
  generateOpenAICompatibleVideo,
  MediaGenerationError,
  type ModelEndpointFetcher,
} from "../lib/llm/media-generation"
import { isLikelyChatModel, modelOutputKind } from "../lib/model-endpoints"

test("classifies common image and video model IDs without misclassifying unknown chat models", () => {
  for (const id of ["image-model", "dall-e-3", "gpt-image-1", "flux.1-dev", "stable-diffusion-xl", "org/sdxl-turbo"]) {
    assert.equal(modelOutputKind(id), "image", id)
    assert.equal(isLikelyChatModel(id), false, id)
  }
  for (const id of ["video-model", "sora-2", "veo3", "kling-v1", "wan2.1", "org/image-to-video-v2"]) {
    assert.equal(modelOutputKind(id), "video", id)
    assert.equal(isLikelyChatModel(id), false, id)
  }
  assert.equal(modelOutputKind("gpt-5.4-mini"), "chat")
  assert.equal(isLikelyChatModel("gpt-5.4-mini"), true)
  assert.equal(isLikelyChatModel("text-embedding-3-small"), false)
})

test("generates an image from b64_json with the OpenAI-compatible request shape", async () => {
  let requestedUrl = ""
  let requestedBody: any
  let authorization = ""
  const fetcher: ModelEndpointFetcher = async (input, init) => {
    requestedUrl = input.toString()
    requestedBody = JSON.parse(String(init?.body))
    authorization = new Headers(init?.headers).get("authorization") ?? ""
    return Response.json({ data: [{ b64_json: "aGVsbG8=" }] })
  }

  const media = await generateOpenAICompatibleMedia({
    baseUrl: "https://media.example/v1/",
    apiKey: "test-credential",
    authType: "bearer",
    model: "gpt-image-1",
    outputKind: "image",
    prompt: "a red square",
    fetcher,
  })

  assert.equal(requestedUrl, "https://media.example/v1/images/generations")
  assert.equal(authorization, "Bearer test-credential")
  assert.deepEqual(requestedBody, {
    model: "gpt-image-1",
    prompt: "a red square",
    n: 1,
    size: "1024x1024",
  })
  assert.deepEqual(media, {
    type: "image",
    url: "data:image/png;base64,aGVsbG8=",
    mimeType: "image/png",
    alt: "a red square",
  })
})

test("media creation retries alternate API key headers after authentication rejection", async () => {
  const attempts: Array<{ authorization: string; xApiKey: string; apiKey: string }> = []
  const media = await generateOpenAICompatibleImage({
    baseUrl: "https://media.example/v1",
    apiKey: "provider-key",
    authType: "bearer",
    model: "gpt-image-1",
    outputKind: "image",
    prompt: "square",
    fetcher: async (_input, init) => {
      const headers = new Headers(init?.headers)
      attempts.push({
        authorization: headers.get("authorization") ?? "",
        xApiKey: headers.get("x-api-key") ?? "",
        apiKey: headers.get("api-key") ?? "",
      })
      if (headers.get("x-api-key") === "provider-key") {
        return Response.json({ data: [{ b64_json: "cG5n" }] })
      }
      return Response.json({ error: { message: "wrong authentication scheme" } }, { status: 401 })
    },
  })

  assert.equal(media.url, "data:image/png;base64,cG5n")
  assert.deepEqual(attempts, [
    { authorization: "Bearer provider-key", xApiKey: "", apiKey: "" },
    { authorization: "", xApiKey: "provider-key", apiKey: "" },
  ])
})

test("video auth fallback reuses the working header for polling and content", async () => {
  const requests: Array<{ url: string; authorization: string; xApiKey: string }> = []
  let acceptedCreates = 0
  const media = await generateOpenAICompatibleVideo({
    baseUrl: "https://media.example/v1",
    apiKey: "provider-key",
    authType: "bearer",
    model: "video-model",
    outputKind: "video",
    prompt: "square",
    pollIntervalMs: 0,
    fetcher: async (input, init) => {
      const url = input.toString()
      const headers = new Headers(init?.headers)
      const request = {
        url,
        authorization: headers.get("authorization") ?? "",
        xApiKey: headers.get("x-api-key") ?? "",
      }
      requests.push(request)
      if (url.endsWith("/videos") && request.xApiKey !== "provider-key") {
        return Response.json({ error: { message: "wrong authentication scheme" } }, { status: 401 })
      }
      if (url.endsWith("/videos")) {
        acceptedCreates++
        return Response.json({ id: "job-auth", status: "completed" })
      }
      assert.equal(request.xApiKey, "provider-key")
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "video/mp4" } })
    },
  })

  assert.equal(acceptedCreates, 1)
  assert.equal(media.url, "data:video/mp4;base64,AQID")
  assert.deepEqual(requests.map(request => [request.url, request.authorization, request.xApiKey]), [
    ["https://media.example/v1/videos", "Bearer provider-key", ""],
    ["https://media.example/v1/videos", "", "provider-key"],
    ["https://media.example/v1/videos/job-auth/content", "", "provider-key"],
  ])
})

test("uses explicit output kind even when the model name has no media hint", async () => {
  const media = await generateOpenAICompatibleMedia({
    baseUrl: "https://media.example/v1",
    authType: "none",
    model: "canvas-v2",
    outputKind: "image",
    prompt: "square",
    fetcher: async () => Response.json({ data: [{ b64_json: "cG5n" }] }),
  })
  assert.equal(modelOutputKind("canvas-v2"), "chat")
  assert.equal(media.type, "image")
})

test("adds the OpenAI v1 prefix for a bare media endpoint origin", async () => {
  let requestedUrl = ""
  await generateOpenAICompatibleImage({
    baseUrl: "https://media.example",
    authType: "none",
    model: "gpt-image-1",
    outputKind: "image",
    prompt: "square",
    fetcher: async input => {
      requestedUrl = input.toString()
      return Response.json({ data: [{ b64_json: "cG5n" }] })
    },
  })
  assert.equal(requestedUrl, "https://media.example/v1/images/generations")
})

test("accepts image URLs and completed SSE image events", async t => {
  await t.test("JSON URL", async () => {
    const requests: Array<{ url: string; authorization: string; redirect?: RequestRedirect }> = []
    const media = await generateOpenAICompatibleImage({
      baseUrl: "https://media.example/v1",
      apiKey: "endpoint-key",
      authType: "bearer",
      model: "flux-1",
      outputKind: "image",
      prompt: "forest",
      fetcher: async (input, init) => {
        requests.push({
          url: input.toString(),
          authorization: new Headers(init?.headers).get("authorization") ?? "",
          redirect: init?.redirect,
        })
        if (requests.length === 1) return Response.json({ data: [{ url: "https://cdn.example/result.png" }] })
        return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/png" } })
      },
    })
    assert.deepEqual(media, {
      type: "image",
      url: "data:image/png;base64,AQID",
      mimeType: "image/png",
      alt: "forest",
    })
    assert.deepEqual(requests.map(request => [request.url, request.authorization, request.redirect]), [
      ["https://media.example/v1/images/generations", "Bearer endpoint-key", "manual"],
      ["https://cdn.example/result.png", "", "manual"],
    ])
  })

  await t.test("SSE completed", async () => {
    const stream = [
      "event: image_generation.started",
      `data: ${JSON.stringify({ type: "image_generation.started" })}`,
      "",
      "event: image_generation.completed",
      `data: ${JSON.stringify({ type: "image_generation.completed", result: "cG5n" })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n")
    const media = await generateOpenAICompatibleImage({
      baseUrl: "https://media.example/v1",
      authType: "none",
      model: "image-model",
      outputKind: "image",
      prompt: "circle",
      fetcher: async () => new Response(stream, { headers: { "Content-Type": "text/event-stream" } }),
    })
    assert.equal(media.url, "data:image/png;base64,cG5n")
  })
})

test("materializes same-origin media with endpoint auth and blocks redirects", async t => {
  await t.test("same-origin URL may use endpoint auth", async () => {
    const seen: Array<{ url: string; authorization: string }> = []
    const media = await generateOpenAICompatibleImage({
      baseUrl: "https://media.example/v1",
      apiKey: "same-origin-key",
      authType: "bearer",
      model: "canvas-v2",
      outputKind: "image",
      prompt: "square",
      fetcher: async (input, init) => {
        seen.push({
          url: input.toString(),
          authorization: new Headers(init?.headers).get("authorization") ?? "",
        })
        if (seen.length === 1) return Response.json({ data: [{ url: "files/result.png" }] })
        return new Response(new Uint8Array([7, 8]), { headers: { "Content-Type": "image/webp" } })
      },
    })
    assert.equal(media.url, "data:image/webp;base64,Bwg=")
    assert.deepEqual(seen, [
      { url: "https://media.example/v1/images/generations", authorization: "Bearer same-origin-key" },
      { url: "https://media.example/v1/files/result.png", authorization: "Bearer same-origin-key" },
    ])
  })

  await t.test("redirects are never followed", async () => {
    let calls = 0
    await assert.rejects(
      generateOpenAICompatibleImage({
        baseUrl: "https://media.example/v1",
        authType: "none",
        model: "image-model",
        outputKind: "image",
        prompt: "square",
        fetcher: async (_input, init) => {
          calls++
          assert.equal(init?.redirect, "manual")
          if (calls === 1) return Response.json({ data: [{ url: "https://cdn.example/result.png" }] })
          return new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/private.png" } })
        },
      }),
      (error: unknown) => error instanceof MediaGenerationError && error.code === "redirect_blocked",
    )
    assert.equal(calls, 2)
  })
})

test("default media URL fetching applies the private-network policy", { concurrency: false }, async t => {
  const mutableEnv = process.env as Record<string, string | undefined>
  const previousNodeEnv = mutableEnv.NODE_ENV
  const previousAllowlist = mutableEnv.MODEL_ENDPOINT_PRIVATE_ALLOWLIST
  const originalLookup = dns.lookup
  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/v1/images/generations") {
      const address = server.address()
      assert.ok(address && typeof address === "object")
      response.writeHead(200, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ data: [{ url: `http://127.0.0.1:${address.port}/private.png` }] }))
      return
    }
    response.writeHead(200, { "Content-Type": "image/png" })
    response.end(new Uint8Array([1]))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert.ok(address && typeof address === "object")
  mutableEnv.NODE_ENV = "production"
  mutableEnv.MODEL_ENDPOINT_PRIVATE_ALLOWLIST = `media-api.invalid:${address.port}`
  dns.lookup = (async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as typeof dns.lookup
  t.after(() => {
    dns.lookup = originalLookup
    server.close()
    if (previousNodeEnv === undefined) delete mutableEnv.NODE_ENV
    else mutableEnv.NODE_ENV = previousNodeEnv
    if (previousAllowlist === undefined) delete mutableEnv.MODEL_ENDPOINT_PRIVATE_ALLOWLIST
    else mutableEnv.MODEL_ENDPOINT_PRIVATE_ALLOWLIST = previousAllowlist
  })

  await assert.rejects(
    generateOpenAICompatibleImage({
      baseUrl: `http://media-api.invalid:${address.port}/v1`,
      authType: "none",
      model: "canvas-v2",
      outputKind: "image",
      prompt: "square",
    }),
    (error: unknown) => error instanceof MediaGenerationError && /私有网络/.test(error.message),
  )
})

test("creates, polls, and downloads an OpenAI-compatible video job", async () => {
  const requests: Array<{ url: string; method: string; body?: any; apiKey: string }> = []
  let polls = 0
  const fetcher: ModelEndpointFetcher = async (input, init) => {
    const url = input.toString()
    const method = init?.method ?? "GET"
    requests.push({
      url,
      method,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      apiKey: new Headers(init?.headers).get("x-api-key") ?? "",
    })
    if (method === "POST") return Response.json({ id: "video_123", status: "queued" })
    if (url.endsWith("/content")) {
      return new Response(new Uint8Array([0, 1, 2, 3]), { headers: { "Content-Type": "video/mp4" } })
    }
    polls++
    return Response.json({ id: "video_123", status: polls === 1 ? "in_progress" : "completed" })
  }

  const media = await generateOpenAICompatibleVideo({
    baseUrl: "https://media.example/v1",
    apiKey: "video-key",
    authType: "x-api-key",
    model: "sora-2",
    outputKind: "video",
    prompt: "waves at sunset",
    fetcher,
    pollIntervalMs: 0,
  })

  assert.deepEqual(requests.map(request => [request.method, request.url]), [
    ["POST", "https://media.example/v1/videos"],
    ["GET", "https://media.example/v1/videos/video_123"],
    ["GET", "https://media.example/v1/videos/video_123"],
    ["GET", "https://media.example/v1/videos/video_123/content"],
  ])
  assert.deepEqual(requests[0].body, {
    model: "sora-2",
    prompt: "waves at sunset",
    size: "1280x720",
    seconds: "4",
  })
  assert.ok(requests.every(request => request.apiKey === "video-key"))
  assert.deepEqual(media, {
    type: "video",
    url: "data:video/mp4;base64,AAECAw==",
    mimeType: "video/mp4",
    alt: "waves at sunset",
  })
})

test("stream cancellation aborts a video while it is waiting to poll", async () => {
  const request = new AbortController()
  const stream = new AbortController()
  const signal = combineMediaGenerationSignals(request.signal, stream.signal)
  let calls = 0
  const generation = generateOpenAICompatibleVideo({
    baseUrl: "https://media.example/v1",
    authType: "none",
    model: "canvas-v2",
    outputKind: "video",
    prompt: "rain",
    signal,
    pollIntervalMs: 10_000,
    fetcher: async () => {
      calls++
      return Response.json({ id: "cancel-job", status: "queued" })
    },
  })
  await new Promise<void>(resolve => setImmediate(resolve))
  stream.abort(new DOMException("cancelled", "AbortError"))
  await assert.rejects(generation, (error: unknown) => error instanceof Error && error.name === "AbortError")
  assert.equal(signal.aborted, true)
  assert.equal(calls, 1)
})

test("accepts a direct video URL returned by a completed status response", async () => {
  const urls: string[] = []
  const fetcher: ModelEndpointFetcher = async input => {
    const url = input.toString()
    urls.push(url)
    if (urls.length === 1) return Response.json({ id: "job-direct", status: "queued" })
    if (urls.length === 2) {
      return Response.json({
        id: "job-direct",
        status: "completed",
        output: { url: "https://cdn.example/generated.mp4" },
      })
    }
    return new Response(new Uint8Array([4, 5, 6]), { headers: { "Content-Type": "video/mp4" } })
  }
  const media = await generateOpenAICompatibleVideo({
    baseUrl: "https://media.example/v1",
    authType: "none",
    model: "veo-3",
    outputKind: "video",
    prompt: "rain",
    fetcher,
    pollIntervalMs: 0,
  })
  assert.equal(media.url, "data:video/mp4;base64,BAUG")
  assert.deepEqual(urls, [
    "https://media.example/v1/videos",
    "https://media.example/v1/videos/job-direct",
    "https://cdn.example/generated.mp4",
  ])
})

test("enforces response and media limits and redacts exact endpoint credentials", async t => {
  await t.test("oversized declared JSON response", async () => {
    await assert.rejects(
      generateOpenAICompatibleImage({
        baseUrl: "https://media.example/v1",
        authType: "none",
        model: "image-model",
        outputKind: "image",
        prompt: "large",
        fetcher: async () => new Response("{}", { headers: { "Content-Length": String(37 * 1024 * 1024) } }),
      }),
      (error: unknown) => error instanceof MediaGenerationError && error.code === "response_too_large",
    )
  })

  await t.test("oversized video content", async () => {
    let call = 0
    await assert.rejects(
      generateOpenAICompatibleVideo({
        baseUrl: "https://media.example/v1",
        authType: "none",
        model: "video-model",
        outputKind: "video",
        prompt: "large",
        pollIntervalMs: 0,
        fetcher: async () => {
          call++
          if (call === 1) return Response.json({ id: "large-job", status: "completed" })
          return new Response(new Uint8Array(), {
            headers: { "Content-Type": "video/mp4", "Content-Length": String(65 * 1024 * 1024) },
          })
        },
      }),
      (error: unknown) => error instanceof MediaGenerationError && error.code === "response_too_large",
    )
  })

  await t.test("exact key redaction", async () => {
    const apiKey = "opaque-provider-credential"
    await assert.rejects(
      generateOpenAICompatibleImage({
        baseUrl: "https://media.example/v1",
        apiKey,
        authType: "api-key",
        model: "image-model",
        outputKind: "image",
        prompt: "error",
        fetcher: async () => Response.json(
          { error: { message: `provider echoed ${apiKey}` } },
          { status: 500 },
        ),
      }),
      (error: unknown) => error instanceof MediaGenerationError
        && !error.message.includes(apiKey)
        && error.message.includes("***"),
    )
  })

  await t.test("permission errors preserve a redacted upstream reason", async () => {
    const apiKey = "opaque-provider-credential"
    let calls = 0
    await assert.rejects(
      generateOpenAICompatibleImage({
        baseUrl: "https://media.example/v1",
        apiKey,
        authType: "bearer",
        model: "gpt-image-1",
        outputKind: "image",
        prompt: "error",
        fetcher: async () => {
          calls++
          return Response.json(
            { error: { message: `Image generation is not enabled for this group (${apiKey})` } },
            { status: 403 },
          )
        },
      }),
      (error: unknown) => error instanceof MediaGenerationError
        && error.code === "permission_denied"
        && error.message.includes("not enabled")
        && !error.message.includes(apiKey),
    )
    assert.equal(calls, 1)
  })
})
