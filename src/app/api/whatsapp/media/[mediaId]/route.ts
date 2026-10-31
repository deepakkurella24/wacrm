import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { getT } from '@/lib/i18n/translate'
import { mediaProxyHeaders } from '@/lib/media/proxy-response-headers'
import { requestB2DownloadUrl, requestB2UploadUrl, uploadToB2 } from '@/lib/media/b2-media-service'
import { resolveMetaCredentials } from '@/lib/whatsapp/meta-credentials'
import { supabaseAdmin } from '@/lib/flows/admin-client'

const t = getT('Api')
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

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

    const cleanMediaId = decodeURIComponent(mediaId).trim()

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
    const isIdUuid = UUID_REGEX.test(cleanMediaId)
    const orConditions: string[] = [
      `message_id.eq.${cleanMediaId}`,
      `media_url.ilike.%${cleanMediaId}%`,
      `media_key.ilike.%${cleanMediaId}%`,
    ]
    if (isIdUuid) {
      orConditions.push(`id.eq.${cleanMediaId}`)
    }

    const msgQuery = supabase
      .from('messages')
      .select('id, conversation_id, media_key, media_mime_type, media_filename, media_url')

    const filteredQuery = typeof (msgQuery as any).or === 'function'
      ? (msgQuery as any).or(orConditions.join(','))
      : msgQuery.eq('message_id', cleanMediaId)

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
    }

    // If stored in Backblaze B2, generate an on-demand signed download URL via FastAPI
    const mediaKeyToFetch = msg?.media_key || (cleanMediaId.startsWith('whatsapp-media/') ? cleanMediaId : null)

    if (mediaKeyToFetch && process.env.FASTAPI_BASE_URL) {
      try {
        const downloadUrl = await requestB2DownloadUrl(mediaKeyToFetch)

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

    // -------------------------------------------------------------------------
    // 2. Fallback: Fetch directly from Meta via WhatsApp Cloud API
    // -------------------------------------------------------------------------
    let accessToken = process.env.META_ACCESS_TOKEN?.trim()

    if (!accessToken) {
      const { data: config, error: configError } = await supabase
        .from('whatsapp_config')
        .select('*')
        .eq('account_id', accountId)
        .single()

      if (configError || !config || !config.access_token) {
        return NextResponse.json(
          { error: t('common.whatsappNotConfigured') },
          { status: 400 }
        )
      }

      accessToken = decrypt(config.access_token)
    }

    // Get the temporary CDN URL from Meta
    const mediaInfo = await getMediaUrl({ mediaId: cleanMediaId, accessToken })

    // Download binary data
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    })

    // If FastAPI is configured and message row exists without media_key, lazily mirror to B2 in background
    if (msg && !msg.media_key && process.env.FASTAPI_BASE_URL) {
      const effectiveMime = contentType || mediaInfo.mimeType || 'application/octet-stream'
      requestB2UploadUrl({
        contentType: effectiveMime,
        referenceId: cleanMediaId,
        filename: msg.media_filename || undefined,
        fileSize: buffer.byteLength,
      })
        .then(async (uploadInfo) => {
          await uploadToB2(uploadInfo.upload_url, buffer, effectiveMime)
          await supabaseAdmin()
            .from('messages')
            .update({
              media_key: uploadInfo.object_key,
              media_mime_type: effectiveMime,
              media_size: buffer.byteLength,
              media_status: 'uploaded',
            })
            .eq('id', msg.id)
        })
        .catch((lazyErr) => {
          console.warn('[media-view] Background lazy B2 mirror failed (non-fatal):', lazyErr)
        })
    }

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: mediaProxyHeaders(cleanMediaId, contentType || mediaInfo.mimeType),
    })
  } catch (error) {
    console.error('Error in WhatsApp media GET:', error)
    return NextResponse.json(
      { error: t('media.fetchFailed') },
      { status: 500 }
    )
  }
}
