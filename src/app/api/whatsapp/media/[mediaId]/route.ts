import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { getT } from '@/lib/i18n/translate'
import { mediaProxyHeaders } from '@/lib/media/proxy-response-headers'
import { requestB2DownloadUrl } from '@/lib/media/b2-media-service'

const t = getT('Api')

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const { mediaId } = await params

    if (!mediaId) {
      return NextResponse.json(
        { error: t('media.idRequired') },
        { status: 400 }
      )
    }

    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { error: t('common.unauthorized') },
        { status: 401 }
      )
    }

    const limit = checkRateLimit(`whatsapp-media:${user.id}`, RATE_LIMITS.whatsappMedia)
    if (!limit.success) return rateLimitResponse(limit)

    // Resolve the caller's account_id
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: t('common.profileNotLinked') },
        { status: 403 },
      )
    }

    // -------------------------------------------------------------------------
    // 1. Check if the media exists in messages and verify conversation ownership
    // -------------------------------------------------------------------------
    const msgQuery = supabase
      .from('messages')
      .select('id, conversation_id, media_key, media_mime_type, media_filename, media_url')

    const filteredQuery = typeof (msgQuery as any).or === 'function'
      ? (msgQuery as any).or(`message_id.eq.${mediaId},id.eq.${mediaId},media_url.ilike.%${mediaId}%`)
      : msgQuery.eq('message_id', mediaId)

    const { data: matchedMessages } = await (typeof (filteredQuery as any).limit === 'function'
      ? (filteredQuery as any).limit(1)
      : filteredQuery)

    const msg = Array.isArray(matchedMessages) ? matchedMessages[0] : matchedMessages

    if (msg) {
      // Enforce conversation authorization: message's conversation must belong to the caller's account
      const { data: conv } = await supabase
        .from('conversations')
        .select('id, account_id')
        .eq('id', msg.conversation_id)
        .maybeSingle()

      if (conv && conv.account_id !== accountId) {
        return NextResponse.json(
          { error: t('common.unauthorized') },
          { status: 403 }
        )
      }

      // If stored in Backblaze B2, generate an on-demand signed download URL via FastAPI
      if (msg.media_key && process.env.FASTAPI_BASE_URL) {
        try {
          const downloadUrl = await requestB2DownloadUrl(msg.media_key)

          const acceptHeader = request.headers.get('accept') || ''
          const urlObj = new URL(request.url)
          if (acceptHeader.includes('application/json') || urlObj.searchParams.get('format') === 'json') {
            return NextResponse.json({ download_url: downloadUrl })
          }

          // Redirect browser directly to Backblaze B2 temporary presigned URL
          return NextResponse.redirect(downloadUrl, { status: 307 })
        } catch (b2Err) {
          console.warn('[media-view] Failed to generate B2 download URL, falling back to Meta:', b2Err)
        }
      }
    }

    // -------------------------------------------------------------------------
    // 2. Fallback: Fetch directly from Meta via WhatsApp Cloud API
    // -------------------------------------------------------------------------
    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        { error: t('common.whatsappNotConfigured') },
        { status: 400 }
      )
    }

    const accessToken = decrypt(config.access_token)

    // Get the temporary CDN URL from Meta
    const mediaInfo = await getMediaUrl({ mediaId, accessToken })

    // Download binary data
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    })

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: mediaProxyHeaders(mediaId, contentType || mediaInfo.mimeType),
    })
  } catch (error) {
    console.error('Error in WhatsApp media GET:', error)
    return NextResponse.json(
      { error: t('media.fetchFailed') },
      { status: 500 }
    )
  }
}
