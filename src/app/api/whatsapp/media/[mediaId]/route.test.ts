import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
  accountId: 'acc-1' as string | null,
  downloadContentType: 'image/jpeg',
  metaMimeType: 'image/jpeg',
  rateLimitOk: true,
  mediaKey: null as string | null,
  conversationAccountId: 'acc-1' as string | null,
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    redirect: (url: string, init?: any) =>
      Response.redirect(url, typeof init === 'number' ? init : (init?.status ?? 307)),
  },
}))

vi.mock('@/lib/media/b2-media-service', () => ({
  requestB2DownloadUrl: async (objectKey: string) =>
    `https://b2.example.com/download/${objectKey}?expires=900`,
  requestB2UploadUrl: async () => ({
    upload_url: 'https://b2.example.com/upload',
    object_key: 'whatsapp-media/lazy/test.jpg',
  }),
  uploadToB2: async () => {},
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: h.user }, error: null }),
    },
    from(table: string) {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        or: () => chain,
        limit: () => chain,
        maybeSingle: async () => {
          if (table === 'profiles' && h.accountId) {
            return { data: { account_id: h.accountId } }
          }
          if (table === 'conversations') {
            return { data: { id: 'conv-1', account_id: h.conversationAccountId } }
          }
          return { data: null }
        },
        single: async () => {
          if (table === 'whatsapp_config') {
            return { data: { access_token: 'enc-token' }, error: null }
          }
          return { data: null, error: null }
        },
        then: (resolve: any) => {
          if (table === 'messages') {
            if (h.mediaKey) {
              return resolve({
                data: [
                  {
                    id: 'msg-1',
                    conversation_id: 'conv-1',
                    media_key: h.mediaKey,
                    media_mime_type: 'image/jpeg',
                  },
                ],
                error: null,
              })
            }
            return resolve({ data: [], error: null })
          }
          return resolve({ data: [], error: null })
        },
      }
      return chain
    },
  }),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (value: string) => `plain-${value}`,
}))

vi.mock('@/lib/rate-limit', () => ({
  RATE_LIMITS: { whatsappMedia: { limit: 240, windowMs: 60_000 } },
  checkRateLimit: () => ({ success: h.rateLimitOk }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
}))

vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: async () => ({
    url: 'https://lookaside.example/media',
    mimeType: h.metaMimeType,
    fileSize: 3,
  }),
  downloadMedia: async () => ({
    buffer: Buffer.from('abc'),
    contentType: h.downloadContentType,
  }),
}))

import { GET } from './route'

function call(mediaId = '1234567890', headers: Record<string, string> = {}) {
  return GET(
    new Request(`http://localhost/api/whatsapp/media/${mediaId}`, { headers }),
    {
      params: Promise.resolve({ mediaId }),
    }
  )
}

beforeEach(() => {
  h.user = { id: 'user-1' }
  h.accountId = 'acc-1'
  h.downloadContentType = 'image/jpeg'
  h.metaMimeType = 'image/jpeg'
  h.rateLimitOk = true
  h.mediaKey = null
  h.conversationAccountId = 'acc-1'
  vi.unstubAllEnvs()
})

describe('GET /api/whatsapp/media/[mediaId]', () => {
  it('serves an image inline with the hardening headers', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(res.headers.get('content-disposition')).toBe('inline')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(await res.text()).toBe('abc')
  })

  it('forces a customer-sent HTML document to download', async () => {
    h.downloadContentType = 'text/html; charset=utf-8'
    h.metaMimeType = 'text/html'
    const res = await call()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBe('attachment')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
  })

  it('forces an SVG image to download', async () => {
    h.downloadContentType = 'image/svg+xml'
    const res = await call()
    expect(res.headers.get('content-disposition')).toBe('attachment')
  })

  it('names a PDF download after the media id', async () => {
    h.downloadContentType = 'application/pdf'
    const res = await call('42')
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="42.pdf"')
  })

  it('never lets a shared cache store the response', async () => {
    const res = await call()
    const cacheControl = res.headers.get('cache-control') ?? ''
    expect(cacheControl).toBe('private, max-age=86400')
    expect(cacheControl).not.toContain('public')
  })

  it('rejects an unauthenticated caller before touching Meta', async () => {
    h.user = null
    const res = await call()
    expect(res.status).toBe(401)
  })

  it('rejects a caller with no linked account', async () => {
    h.accountId = null
    const res = await call()
    expect(res.status).toBe(403)
  })

  it('redirects to signed Backblaze B2 download URL when media_key is present', async () => {
    vi.stubEnv('FASTAPI_BASE_URL', 'http://127.0.0.1:8000')
    h.mediaKey = 'whatsapp-media/12345/document.pdf'

    const res = await call('12345')
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe(
      'https://b2.example.com/download/whatsapp-media/12345/document.pdf?expires=900'
    )
  })

  it('returns JSON with signed download_url when Accept: application/json is sent', async () => {
    vi.stubEnv('FASTAPI_BASE_URL', 'http://127.0.0.1:8000')
    h.mediaKey = 'whatsapp-media/12345/document.pdf'

    const res = await call('12345', { Accept: 'application/json' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.download_url).toBe(
      'https://b2.example.com/download/whatsapp-media/12345/document.pdf?expires=900'
    )
  })

  it('refuses access with 403 when user belongs to a different account than the conversation', async () => {
    vi.stubEnv('FASTAPI_BASE_URL', 'http://127.0.0.1:8000')
    h.mediaKey = 'whatsapp-media/12345/document.pdf'
    h.conversationAccountId = 'different-account-id'

    const res = await call('12345')
    expect(res.status).toBe(403)
  })

  it('handles numeric Meta media ID and WAMID without uuid cast failures', async () => {
    vi.stubEnv('FASTAPI_BASE_URL', 'http://127.0.0.1:8000')
    h.mediaKey = 'whatsapp-media/2225235245071102/photo.jpg'

    const resNum = await call('2225235245071102')
    expect(resNum.status).toBe(307)
    expect(resNum.headers.get('location')).toContain('whatsapp-media/2225235245071102/photo.jpg')

    const resWamid = await call('wamid.HBgMOTE3ODQyNTIzODM1FQIAEhggQUNDMUE4ODJCRDEwNDc5MTk5NDA0NzAxN0QxQ0U4NkIA')
    expect(resWamid.status).toBe(307)
  })

  it('directly serves Backblaze B2 object keys starting with whatsapp-media/', async () => {
    vi.stubEnv('FASTAPI_BASE_URL', 'http://127.0.0.1:8000')
    h.mediaKey = null

    const res = await call('whatsapp-media%2Fdirect%2Ffile.png')
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('whatsapp-media/direct/file.png')
  })
})
