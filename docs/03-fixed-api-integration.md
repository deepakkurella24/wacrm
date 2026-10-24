# 3. Fixed Server-to-Server API Integration

This document specifies the fixed, server-side Public API integration between the **FastAPI Insurance Management Application** and **WACRM**.

---

## 1. Authentication & Security Model

- **No Frontend Management**: API key generation, revocation, and scope forms have been completely removed from the WACRM UI.
- **Fixed Service Key**: A fixed service credential (`WACRM_SERVICE_API_KEY`) is configured via environment variables.
- **Constant-Time Verification**: WACRM computes SHA-256 hashes of the incoming bearer token and configured server key, comparing them with `crypto.timingSafeEqual` to eliminate timing attacks.
- **Least-Privilege Scoping**: The fixed service key is strictly provisioned with the `messages:send` scope. Accessing routes requiring other scopes returns `403 Forbidden`.
- **Database Provisioning**: On boot or first request, WACRM idempotently registers this key in the `api_keys` table as `'Fixed Public API Service Key'` and tracks `last_used_at`.

---

## 2. Endpoint: Send WhatsApp Message

Send text, Meta-approved templates, or media messages to a customer using their phone number.

### Request
- **Method**: `POST`
- **URL**: `https://<wacrm-host>/api/v1/messages`
- **Headers**:
  ```http
  Authorization: Bearer <WACRM_SERVICE_API_KEY>
  Content-Type: application/json
  ```

### Request Body Schema

```typescript
{
  "to": string,                   // Required: Phone number in E.164 format (e.g. "+919876543210")
  "type": "text" | "template" | "document" | "image" | "video" | "audio", // Default: "text"
  "text"?: string,                // Text content or media caption
  "template"?: {                  // Required when type="template"
    "name": string,               // Meta-approved template name
    "language": string,           // e.g. "en" or "en_US"
    "params": string[] | object   // Positional body strings or structured payload
  },
  "media_url"?: string,           // Required for document/image/video/audio
  "filename"?: string,            // Optional filename for document attachments
  "reply_to_message_id"?: string, // Optional: UUID of message to quote reply
  "name"?: string                 // Optional: contact full name to save on first message
}
```

### Examples

#### A. Approved Meta Reminder Template
```json
{
  "to": "+919876543210",
  "name": "Rahul Sharma",
  "type": "template",
  "template": {
    "name": "policy_renewal_reminder",
    "language": "en",
    "params": [
      "Rahul Sharma",
      "MH12AB1234",
      "14250",
      "20-Nov-2026",
      "https://secure-pay.insurer.com/p/12345"
    ]
  }
}
```

#### B. Sending Renewed Policy PDF Document
```json
{
  "to": "+919876543210",
  "type": "document",
  "media_url": "https://s3.eu-central-003.backblazeb2.com/bucket/policies/AP20BA1232_policy.pdf",
  "filename": "Insurance_Policy_AP20BA1232.pdf",
  "text": "Dear customer, please find attached your renewed insurance policy schedule."
}
```

#### C. Standard Text Message
```json
{
  "to": "+919876543210",
  "type": "text",
  "text": "Hello, your renewal inquiry has been received. Our team will contact you shortly."
}
```

### Success Response (`201 Created`)
```json
{
  "data": {
    "message_id": "4a713b18-...",
    "whatsapp_message_id": "wamid.HBgL...",
    "conversation_id": "8c208c02-...",
    "contact_id": "3e9b11cf-...",
    "contact_created": false
  }
}
```

### Error Responses
- `401 Unauthorized`: Missing or invalid Bearer token.
- `403 Forbidden`: API key lacks required scope.
- `400 Bad Request`: Missing `to` phone number or missing required type payload.
- `422 Unprocessable Content`: Invalid E.164 phone number format.
- `429 Too Many Requests`: Rate limit of 120 requests/minute exceeded.

---

## 3. Python FastAPI Client Usage

The FastAPI backend provides a built-in helper service in `backend/app/services/wacrm.py`:

```python
from app.services.wacrm import send_whatsapp_message, WACRMError

# 1. Send template renewal reminder
try:
    response = send_whatsapp_message(
        to="9876543210",  # Automatically formatted to +919876543210
        message_type="template",
        template={
            "name": "policy_renewal_reminder",
            "language": "en",
            "params": ["Rahul Sharma", "MH12AB1234", "14250", "20-Nov-2026", "https://pay.example.com/123"],
        },
        name="Rahul Sharma",
    )
    print("Sent message:", response["data"]["message_id"])
except WACRMError as e:
    print(f"Failed to send reminder (HTTP {e.status_code}): {e}")

# 2. Send policy document attachment
try:
    response = send_whatsapp_message(
        to="+919876543210",
        message_type="document",
        media_url="https://s3.eu-central-003.backblazeb2.com/bucket/policy.pdf",
        filename="Policy_Schedule.pdf",
        text="Here is your policy schedule.",
    )
except WACRMError as e:
    logger.error("Document delivery failed: %s", e)
```
