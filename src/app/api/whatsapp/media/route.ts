import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { resolveMetaCredentials } from '@/lib/whatsapp/meta-credentials';
import { uploadMediaToMeta } from '@/lib/whatsapp/meta-api';
import { MEDIA_MAX_BYTES } from '@/lib/storage/upload-media';
import { getT } from '@/lib/i18n/translate';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { requestB2UploadUrl, uploadToB2 } from '@/lib/media/b2-media-service';

const t = getT('Api');

/**
 * POST /api/whatsapp/media
 *
 * Direct media upload endpoint. Receives file multipart uploads from the
 * browser (composer, flow builder, or template manager), uploads them
 * directly to Meta's Cloud API to get a Meta Media ID, and optionally
 * mirrors to Backblaze B2.
 */
export async function POST(request: Request) {
  try {
    const { accountId } = await requireRole('agent');

    const formData = await request.formData().catch(() => null);
    if (!formData) {
      return NextResponse.json({ error: t('common.invalidJson') }, { status: 400 });
    }

    const file = formData.get('file');
    if (!file || !(file instanceof Blob)) {
      return NextResponse.json({ error: 'A file is required' }, { status: 400 });
    }

    if (file.size > MEDIA_MAX_BYTES) {
      return NextResponse.json({ error: 'File size exceeds 16 MB limit' }, { status: 413 });
    }

    const creds = await resolveMetaCredentials(supabaseAdmin(), accountId);
    if (!creds) {
      return NextResponse.json({ error: t('common.whatsappNotConfigured') }, { status: 400 });
    }

    const filename = (file as any).name || 'attachment';
    const mimeType = file.type || 'application/octet-stream';

    // 1. Upload directly to Meta Cloud API to obtain a valid Meta Media ID
    const { mediaId } = await uploadMediaToMeta({
      phoneNumberId: creds.phoneNumberId,
      accessToken: creds.accessToken,
      file,
      mimeType,
      filename,
    });

    // 2. Optionally mirror to Backblaze B2 if FastAPI is configured
    let b2ObjectKey: string | null = null;
    if (process.env.FASTAPI_BASE_URL) {
      try {
        const uploadInfo = await requestB2UploadUrl({
          contentType: mimeType,
          referenceId: mediaId,
          filename,
          fileSize: file.size,
        });
        const arrayBuf = await file.arrayBuffer();
        await uploadToB2(uploadInfo.upload_url, Buffer.from(arrayBuf), mimeType);
        b2ObjectKey = uploadInfo.object_key;
      } catch (b2Err) {
        console.warn('[media-upload] B2 mirror failed (non-fatal):', b2Err);
      }
    }

    return NextResponse.json({
      success: true,
      media_id: mediaId,
      publicUrl: `/api/whatsapp/media/${mediaId}`,
      path: mediaId,
      b2_object_key: b2ObjectKey,
    });
  } catch (err) {
    console.error('[POST /api/whatsapp/media] upload error:', err);
    return toErrorResponse(err);
  }
}
