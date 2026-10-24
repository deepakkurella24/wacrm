import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  requestB2UploadUrl,
  uploadToB2,
  requestB2DownloadUrl,
  mirrorInboundMediaToB2,
  MEDIA_MAX_BYTES,
} from './b2-media-service'

const FASTAPI_URL = 'http://127.0.0.1:8000'
const SERVICE_TOKEN = 'secret-service-token'

describe('b2-media-service', () => {
  beforeEach(() => {
    vi.stubEnv('FASTAPI_BASE_URL', FASTAPI_URL)
    vi.stubEnv('FASTAPI_SERVICE_TOKEN', SERVICE_TOKEN)
    vi.restoreAllMocks()
  })

  describe('requestB2UploadUrl', () => {
    it('requests an upload URL from FastAPI with auth headers', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          upload_url: 'https://b2.example.com/put-signed',
          object_key: 'whatsapp-media/123/image.jpg',
        }),
      } as Response)

      const result = await requestB2UploadUrl({
        contentType: 'image/jpeg',
        referenceId: '123',
        filename: 'image.jpg',
        fileSize: 1024,
      })

      expect(result).toEqual({
        upload_url: 'https://b2.example.com/put-signed',
        object_key: 'whatsapp-media/123/image.jpg',
      })

      expect(fetchSpy).toHaveBeenCalledWith(
        `${FASTAPI_URL}/api/v1/storage/upload-url`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'X-Service-Token': SERVICE_TOKEN,
            Authorization: `Bearer ${SERVICE_TOKEN}`,
            'Content-Type': 'application/json',
          }),
        })
      )
    })

    it('throws error when FastAPI returns an error status', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      } as Response)

      await expect(
        requestB2UploadUrl({
          contentType: 'image/jpeg',
          referenceId: '123',
        })
      ).rejects.toThrow('FastAPI upload-url endpoint failed with status 401')
    })
  })

  describe('uploadToB2', () => {
    it('sends binary data directly to the presigned upload URL via PUT', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
      } as Response)

      const buffer = Buffer.from('test-image-bytes')
      await uploadToB2('https://b2.example.com/put-signed', buffer, 'image/jpeg')

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://b2.example.com/put-signed',
        expect.objectContaining({
          method: 'PUT',
          headers: { 'Content-Type': 'image/jpeg' },
          body: buffer,
        })
      )
    })

    it('throws error when direct B2 upload fails', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'RequestTimeTooSkewed',
      } as Response)

      await expect(
        uploadToB2('https://b2.example.com/put-signed', Buffer.from('x'), 'image/jpeg')
      ).rejects.toThrow('Direct upload to Backblaze B2 failed with status 403')
    })
  })

  describe('requestB2DownloadUrl', () => {
    it('requests a temporary download URL from FastAPI', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          download_url: 'https://b2.example.com/get-signed?expires=900',
        }),
      } as Response)

      const url = await requestB2DownloadUrl('whatsapp-media/123/invoice.pdf')
      expect(url).toBe('https://b2.example.com/get-signed?expires=900')

      expect(fetchSpy).toHaveBeenCalledWith(
        `${FASTAPI_URL}/api/v1/storage/download-url`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'X-Service-Token': SERVICE_TOKEN,
            Authorization: `Bearer ${SERVICE_TOKEN}`,
          }),
          body: JSON.stringify({ object_key: 'whatsapp-media/123/invoice.pdf' }),
        })
      )
    })
  })

  describe('mirrorInboundMediaToB2', () => {
    it('skips media larger than 16 MB before downloading', async () => {
      const downloadFn = vi.fn()
      const result = await mirrorInboundMediaToB2({
        mediaId: 'large-doc',
        downloadUrl: 'https://lookaside.example.com/doc',
        accessToken: 'token',
        fileSize: 20 * 1024 * 1024,
        downloadFn,
      })

      expect(result).toBeNull()
      expect(downloadFn).not.toHaveBeenCalled()
    })

    it('downloads from Meta, requests upload URL, uploads to B2, and returns metadata', async () => {
      const downloadFn = vi.fn().mockResolvedValueOnce({
        buffer: Buffer.from('fake-pdf-content'),
        contentType: 'application/pdf',
      })

      // 1st fetch: FastAPI upload-url
      // 2nd fetch: B2 PUT upload
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            upload_url: 'https://b2.example.com/upload-signed',
            object_key: 'whatsapp-media/media-456/policy.pdf',
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
        } as Response)

      const result = await mirrorInboundMediaToB2({
        mediaId: 'media-456',
        downloadUrl: 'https://lookaside.example.com/doc',
        accessToken: 'token',
        fileName: 'policy.pdf',
        mimeType: 'application/pdf',
        downloadFn,
      })

      expect(result).toEqual({
        objectKey: 'whatsapp-media/media-456/policy.pdf',
        mimeType: 'application/pdf',
        fileSize: Buffer.from('fake-pdf-content').byteLength,
        filename: 'policy.pdf',
        status: 'uploaded',
      })
    })

    it('returns null safely on network error without throwing', async () => {
      const downloadFn = vi.fn().mockRejectedValueOnce(new Error('Meta network error'))

      const result = await mirrorInboundMediaToB2({
        mediaId: 'media-fail',
        downloadUrl: 'https://lookaside.example.com/doc',
        accessToken: 'token',
        downloadFn,
      })

      expect(result).toBeNull()
    })
  })
})
