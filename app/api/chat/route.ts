import { NextRequest, NextResponse } from 'next/server'

const SYSTEM = `你是一个有文学气质的对话伙伴，用温暖、有质感的中文与用户交谈，如同在信笺上写字。
语言自然流露，不堆砌辞藻，也不过于简洁。偶尔引用诗句或比喻，但要恰到好处。`

export async function POST(req: NextRequest) {
  const { model, messages, apiKey } = await req.json()

  if (!apiKey) {
    return NextResponse.json({ error: '请先在侧边栏设置中填写 API Key' }, { status: 400 })
  }

  try {
    // Claude (Anthropic)
    if (model === 'claude') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          system: SYSTEM,
          messages,
        }),
      })
      const data = await res.json()
      if (!res.ok) return NextResponse.json({ error: data.error?.message || '请求失败' }, { status: res.status })
      return NextResponse.json({ content: data.content[0].text })
    }

    // Gemini (Google, OpenAI-compatible endpoint)
    if (model === 'gemini') {
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gemini-2.0-flash',
          messages: [{ role: 'system', content: SYSTEM }, ...messages],
        }),
      })
      const data = await res.json()
      if (!res.ok) return NextResponse.json({ error: data.error?.message || '请求失败' }, { status: res.status })
      return NextResponse.json({ content: data.choices[0].message.content })
    }

    // DeepSeek (OpenAI-compatible)
    if (model === 'deepseek') {
      const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [{ role: 'system', content: SYSTEM }, ...messages],
        }),
      })
      const data = await res.json()
      if (!res.ok) return NextResponse.json({ error: data.error?.message || '请求失败' }, { status: res.status })
      return NextResponse.json({ content: data.choices[0].message.content })
    }

    // GPT (OpenAI)
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: SYSTEM }, ...messages],
      }),
    })
    const data = await res.json()
    if (!res.ok) return NextResponse.json({ error: data.error?.message || '请求失败' }, { status: res.status })
    return NextResponse.json({ content: data.choices[0].message.content })

  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
