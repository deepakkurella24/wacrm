import { downloadMedia } from '@/lib/whatsapp/meta-api';

/**
 * 16 MB — Maximum inbound media file size allowed for WhatsApp media.
 * Aligns with Meta's document limits and our B2 storage quota cap.
 */
export const MEDIA_MAX_BYTES = 16 * 1024 * 1024;

export interface B2UploadUrlResponse {
  upload_url: string;
  object_key: string;
}

export interface B2DownloadUrlResponse {
  download_url: string;
}

export interface MirrorMediaResult {
  objectKey: string;
  mimeType: string;
  fileSize: number;
  filename: string | null;
  status: 'uploaded' | 'failed';
}

function getFastApiHeaders(): Record<string, string> {
  const serviceToken = process.env.FASTAPI_SERVICE_TOKEN;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (serviceToken) {
    headers['X-Service-Token'] = serviceToken;
    headers['Authorization'] = `Bearer ${serviceToken}`;
  }
  return headers;
}

function getFastApiBaseUrl(): string {
  const baseUrl = process.env.FASTAPI_BASE_URL;
  if (!baseUrl) {
    throw new Error('FASTAPI_BASE_URL environment variable is not configured');
  }
  return baseUrl.replace(/\/+$/, '');
}

/**
 * Requests a short-lived presigned PUT URL and object key from FastAPI.
 */
export async function requestB2UploadUrl(params: {
  contentType: string;
  referenceId: string;
  filename?: string | null;
  fileSize?: number | null;
}): Promise<B2UploadUrlResponse> {
  const baseUrl = getFastApiBaseUrl();
  const url = `${baseUrl}/api/v1/storage/upload-url`;

  const response = await fetch(url, {
    method: 'POST',
    headers: getFastApiHeaders(),
    body: JSON.stringify({
      content_type: params.contentType,
      reference_id: params.referenceId,
      filename: params.filename || undefined,
      file_size: params.fileSize || undefined,
    }),
    signal: AbortSignal.timeout(10000), // 10s timeout
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(
      `FastAPI upload-url endpoint failed with status ${response.status}: ${errorText}`
    );
  }

  return (await response.json()) as B2UploadUrlResponse;
}

/**
 * Uploads media bytes directly to Backblaze B2 using the presigned PUT URL.
 */
export async function uploadToB2(
  uploadUrl: string,
  buffer: Buffer | Uint8Array,
  contentType: string
): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
    },
    body: buffer as unknown as BodyInit,
    signal: AbortSignal.timeout(60000), // 60s timeout for large uploads
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(
      `Direct upload to Backblaze B2 failed with status ${response.status}: ${errorText}`
    );
  }
}

/**
 * Requests a short-lived presigned GET download URL from FastAPI.
 */
export async function requestB2DownloadUrl(objectKey: string): Promise<string> {
  const baseUrl = getFastApiBaseUrl();
  const url = `${baseUrl}/api/v1/storage/download-url`;

  const response = await fetch(url, {
    method: 'POST',
    headers: getFastApiHeaders(),
    body: JSON.stringify({
      object_key: objectKey,
    }),
    signal: AbortSignal.timeout(10000), // 10s timeout
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(
      `FastAPI download-url endpoint failed with status ${response.status}: ${errorText}`
    );
  }

  const data = (await response.json()) as B2DownloadUrlResponse;
  return data.download_url;
}

/**
 * Downloads incoming WhatsApp media from Meta and uploads it directly to Backblaze B2.
 * Returns the object key and metadata, or null on failure (never throws, so webhooks don't fail).
 */
export async function mirrorInboundMediaToB2(params: {
  mediaId: string;
  downloadUrl: string;
  accessToken: string;
  mimeType?: string | null;
  fileSize?: number | null;
  fileName?: string | null;
  downloadFn?: typeof downloadMedia;
}): Promise<MirrorMediaResult | null> {
  const {
    mediaId,
    downloadUrl,
    accessToken,
    mimeType,
    fileSize,
    fileName,
    downloadFn = downloadMedia,
  } = params;

  // 1. Guard against oversized files before spending network transfer
  if (typeof fileSize === 'number' && fileSize > MEDIA_MAX_BYTES) {
    console.warn(
      `[b2-media] skipping ${mediaId}: ${fileSize} bytes exceeds the ${MEDIA_MAX_BYTES}-byte limit`
    );
    return null;
  }

  try {
    // 2. Download binary bytes from Meta
    const { buffer, contentType: metaContentType } = await downloadFn({
      downloadUrl,
      accessToken,
    });

    if (buffer.byteLength > MEDIA_MAX_BYTES) {
      console.warn(
        `[b2-media] skipping ${mediaId}: downloaded ${buffer.byteLength} bytes exceeds ${MEDIA_MAX_BYTES}-byte limit`
      );
      return null;
    }

    const effectiveMime =
      mimeType?.split(';')[0].trim().toLowerCase() ||
      metaContentType?.split(';')[0].trim().toLowerCase() ||
      'application/octet-stream';

    // 3. Request temporary presigned PUT upload URL from FastAPI
    const { upload_url, object_key } = await requestB2UploadUrl({
      contentType: effectiveMime,
      referenceId: mediaId,
      filename: fileName,
      fileSize: buffer.byteLength,
    });

    // 4. Stream bytes directly to Backblaze B2
    await uploadToB2(upload_url, buffer, effectiveMime);

    return {
      objectKey: object_key,
      mimeType: effectiveMime,
      fileSize: buffer.byteLength,
      filename: fileName || null,
      status: 'uploaded',
    };
  } catch (error) {
    console.warn(
      `[b2-media] failed to mirror media ${mediaId} to Backblaze B2:`,
      error instanceof Error ? error.message : error
    );
    return null;
  }
}
