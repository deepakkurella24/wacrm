# 2. Workflows & Messaging Guide

This guide details the specialized workflow engine, inbound message processing hierarchy, the hardcoded `Renewals on My Number` trigger, and incoming media storage in Backblaze B2.

---

## 1. Inbound Message Precedence & Fallback Hierarchy

When an inbound message is received from Meta's webhook (`POST /api/whatsapp/webhook`), WACRM processes it using strict precedence:

```
                  ┌────────────────────────────────────────┐
                  │          Inbound WhatsApp Message      │
                  └───────────────────┬────────────────────┘
                                      │
                                      ▼
                 Does it match "Renewals on My Number"?
                                 /          \
                            [Yes]            [No]
                              /                \
                             ▼                  ▼
              Execute Hardcoded FastAPI    Does text match any active
              Renewal Query Workflow       Keyword Flow in /flows?
                                                  /          \
                                             [Yes]            [No]
                                               /                \
                                              ▼                  ▼
                                     Execute matched       Does text match
                                     Flow reply            "MENU" / "HELP"?
                                                                /          \
                                                           [Yes]            [No]
                                                             /                \
                                                            ▼                  ▼
                                                   Send Active Services   Does text match
                                                   Menu (all options)     a Greeting ("HI")?
                                                                               /          \
                                                                          [Yes]            [No]
                                                                            /                \
                                                                           ▼                  ▼
                                                                 Send Greeting +       Send Unrecognized
                                                                 Active Menu           Fallback Guidance
```

---

## 2. Hardcoded Trigger: "Renewals on My Number"

### How It Works
1. **Trigger Matching**:
   - Case-insensitive check for `"Renewals on My Number"`.
   - Strips leading and trailing punctuation (e.g. `!`, `?`, `.`, quotes) and handles variable whitespace.
   - Rejects unrelated sentences that merely happen to contain similar words.
2. **Verified Sender Identification**:
   - Uses the verified sender phone number from Meta (`message.from` / `contact.phone`).
   - Normalizes the phone number (stripping non-digits, country code `91`, leading `0`).
3. **FastAPI Authenticated Lookup**:
   - Calls `GET /api/v1/integrations/renewals-by-phone?phone={normalized_phone}`.
   - Passes `FASTAPI_SERVICE_TOKEN` via `X-Service-Token` and `Authorization: Bearer`.
4. **Structured Formatting**:
   - Renders a clean numbered list of vehicles:
     ```
     Your Vehicle Renewal Details

     1. AP20BA1232 – Honda City
     Payment status: ✅ Payment completed
     Policy document: https://insurance-backend.onrender.com/api/v1/integrations/document-download?token=...

     2. AP22BC1222 – Hyundai Creta
     Payment status: ⏳ Payment pending
     Balance due: ₹12,500
     Payment link: https://secure-pay.insurer.com/p/12345

     ⚠️ Policy document links expire in 5 minutes. Please download your document immediately.
     ```
   - Appends the 5-minute expiry warning **only** when at least one policy document link is present.
   - Policy document download links route through the backend's signed URL handler with a 300-second expiration.
   - If no records are found, replies politely that no policies are registered under that number.

---

## 3. Client-Configurable Workflows (`/flows`)

For general customer inquiries (e.g., office address, office hours, claim assistance):
1. Navigate to the **Workflows** page (`/flows`) in the WACRM dashboard.
2. Create or edit a workflow:
   - **Trigger Keyword**: Specify keywords (e.g. `office`, `address`, `timing`).
   - **Action**: Configure the WhatsApp response text.
3. Toggle between **Active** and **Draft**:
   - Only workflows marked `active` are executed.
   - Disabled/draft workflows are automatically omitted from message matching and the `MENU` reply.

---

## 4. Incoming WhatsApp Media Integration (Backblaze B2)

When a customer sends an image, PDF, document, audio note, or video:

```
[Customer on WhatsApp]
          │
          │ Sends Media (Image/PDF)
          ▼
[Meta WhatsApp Cloud API]
          │
          │ Inbound Webhook (with media_id)
          ▼
[WACRM Webhook Handler]
          │
          │ 1. Download binary buffer from Meta Graph API
          │ 2. Request presigned upload URL: POST /api/v1/storage/upload-url (FastAPI)
          ▼
[FastAPI Storage Service]
          │
          │ Generates Backblaze B2 PUT presigned URL (15-min expiry)
          ▼
[WACRM Webhook Handler]
          │
          │ 3. Streams buffer directly to Backblaze B2 bucket
          │ 4. Persists message in Neon with media_key, mime_type, and filename
          ▼
[Agent in WACRM Inbox]
          │
          │ Clicks "View" on attachment: GET /api/whatsapp/media/[mediaId]
          ▼
[WACRM Media Route]
          │
          │ 1. Checks agent authentication and conversation account ownership
          │ 2. Requests signed GET download URL: POST /api/v1/storage/download-url (FastAPI)
          │ 3. Issues HTTP 307 redirect to temporary 15-minute Backblaze B2 signed URL
```

### Key Security Properties:
- **Private Bucket**: The Backblaze B2 bucket is completely private.
- **No Shared Credentials**: Backblaze B2 credentials exist exclusively in FastAPI. WACRM never accesses the storage keys directly.
- **Tenant Authorization**: The media download route verifies that the requesting agent belongs to the conversation's account before requesting a signed download URL.
