# 4. Troubleshooting Guide

This guide covers common issues and resolution steps across WhatsApp Cloud API connectivity, webhooks, server-to-server communication, and media attachments.

---

## 1. WhatsApp Cloud API & Token Errors

### "Session Expired" or Error Code 190
- **Symptoms**: Outbound messages fail with HTTP 400/401 and Meta error `190 / 463: Session has expired`.
- **Cause**: The `META_ACCESS_TOKEN` was generated with a temporary 24-hour expiration or has been revoked.
- **Solution**:
  1. Go to **Meta Business Settings → Users → System Users**.
  2. Select your Admin system user and click **Generate New Token**.
  3. Ensure permissions `whatsapp_business_messaging` and `whatsapp_business_management` are checked.
  4. Select expiration: **Never**.
  5. Update `META_ACCESS_TOKEN` in your environment (`.env` or Netlify).

### "Phone Number ID Mismatch" (Code 100)
- **Symptoms**: Messages fail with `(#100) Param recipient_type must be individual` or unknown phone number.
- **Cause**: Using the actual phone number digits instead of the numeric ID assigned by Meta.
- **Solution**: In Meta WhatsApp Manager → **API Setup**, copy the numeric **Phone number ID** (e.g. `102938475610293`), NOT the phone number itself. Set this in `META_PHONE_NUMBER_ID`.

---

## 2. Webhook Delivery & Verification Failures

### Webhook Verification Fails in Meta Dashboard
- **Symptoms**: Clicking "Verify and Save" in Meta Developer Portal shows `The URL couldn't be validated`.
- **Cause**:
  1. The verify token typed into Meta doesn't match `META_WEBHOOK_VERIFY_TOKEN`.
  2. The server or ngrok tunnel is offline or returning a 4xx/5xx code on `GET /api/whatsapp/webhook`.
- **Solution**:
  1. Ensure your local server (`npm run dev`) or Netlify deployment is running.
  2. Check that `GET https://<your-host>/api/whatsapp/webhook?hub.mode=subscribe&hub.challenge=112233&hub.verify_token=<token>` returns `112233` with status 200.

### Inbound Messages Do Not Appear in Inbox
- **Symptoms**: Customers send messages, but nothing shows up in WACRM.
- **Solution**:
  1. Verify Webhook Field Subscriptions: In Meta Developer Portal → **WhatsApp → Configuration**, check that the `messages` field is subscribed.
  2. Check HMAC Signature: Ensure `META_APP_SECRET` matches your Meta App's Basic App Secret. Mismatched app secrets cause the webhook handler to reject incoming payloads with `401 Unauthorized`.
  3. Review Server Logs: Inspect Netlify function logs or terminal logs for incoming `POST /api/whatsapp/webhook` requests.

---

## 3. Server-to-Server API Issues (FastAPI <-> WACRM)

### HTTP 401 Unauthorized from `POST /api/v1/messages`
- **Cause**: Mismatched service key between FastAPI and WACRM.
- **Solution**: Ensure `WACRM_SERVICE_API_KEY` in `backend/.env` exactly matches `WACRM_SERVICE_API_KEY` (or `WACRM_API_KEY`) in `WACRM/.env`.

### HTTP 403 Forbidden from `POST /api/v1/messages`
- **Cause**: Requesting an endpoint or operation with a key lacking the `messages:send` scope.
- **Solution**: The fixed service key is provisioned with `messages:send`. Ensure your request is targeting `/api/v1/messages`.

### `Renewals on My Number` Returns "Failed to retrieve renewals"
- **Cause**: WACRM cannot authenticate to FastAPI's `/api/v1/integrations/renewals-by-phone`.
- **Solution**:
  1. Check `FASTAPI_BASE_URL` in WACRM: ensure it points to the running backend (e.g. `http://localhost:8000` or production Render URL).
  2. Check `FASTAPI_SERVICE_TOKEN`: verify that the token in `WACRM/.env` matches `FASTAPI_SERVICE_TOKEN` in `backend/.env`.
  3. Check `WORKFLOW_ALLOWED_HOSTS`: ensure the hostname of `FASTAPI_BASE_URL` is listed (e.g. `localhost,127.0.0.1,insurance-backend.onrender.com`).

---

## 4. Backblaze B2 Media Storage Issues

### Customer Sends Attachment, but Viewing in Inbox Fails
- **Cause**:
  1. FastAPI cannot generate Backblaze B2 signed download URLs because credentials (`B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET`) are incorrect or expired.
  2. The attachment upload failed during incoming webhook processing.
- **Solution**:
  1. Verify Backblaze B2 credentials in `backend/.env` using the unit test suite (`.\.venv\Scripts\python.exe -m unittest tests/test_storage.py`).
  2. Check WACRM logs: verify that `POST /api/v1/storage/upload-url` returns status 200 with a presigned upload URL.
  3. Ensure file size is below the 16 MB WhatsApp media download limit.
