# WACRM Customization Guide — Insurance WhatsApp Inbox Edition

This guide details the architecture, setup, deployment, and operational procedures for the customized single-agent **Insurance WhatsApp Inbox** and workflow engine.

---

## 1. System Architecture

```
┌──────────────────────────────────────┐          ┌──────────────────────────────────────┐
│ Application A: Insurance Backend     │          │ Application B: Customized WACRM     │
│ (FastAPI on Render Free)             │          │ (Next.js App Router on Netlify Free) │
│ - Neon PostgreSQL Project A          │          │ - Neon PostgreSQL Project B          │
│ - Authoritative Insurance Database   │          │ - Clerk Authentication               │
│ - Policy, vehicle, renewal data      │          │ - Inbox, Conversations, Workflows    │
└──────────────────┬───────────────────┘          └──────────────────┬───────────────────┘
                   │                                                 │
                   │ Authenticated HTTPS (FASTAPI_SERVICE_TOKEN)     │ Direct Cloud API
                   │                                                 │ (META_ACCESS_TOKEN)
                   ▼                                                 ▼
     ┌───────────────────────────┐                     ┌───────────────────────────┐
     │ FastAPI Integration Router│                     │ Official Meta WhatsApp    │
     │ /api/v1/integrations/*    │                     │ Cloud API (Graph v22.0)   │
     └───────────────────────────┘                     └───────────────────────────┘
```

### Critical Security Boundaries
- **Zero Frontend WhatsApp Configuration**: All Meta access tokens, App Secrets, and phone IDs are read strictly on the server (`process.env`). No secret is bundled in client scripts or returned in APIs.
- **Database Separation**: WACRM never connects directly to Application A's database. Information is exchanged via authenticated REST requests (`X-Service-Token`).
- **SSRF Protection**: Outbound workflow HTTP calls are guarded against internal IP probing, restricted to `FASTAPI_BASE_URL` and allow-listed hostnames.

---

## 2. Database Setup (Neon PostgreSQL Project B)

1. Create a blank PostgreSQL project on [Neon](https://neon.tech).
2. Open the **SQL Editor** in your Neon dashboard.
3. Open `neon_schema.sql` located at the root of this repository.
4. Execute the SQL script. This creates:
   - `accounts` and `profiles` with Clerk `TEXT` user IDs.
   - `contacts`, `tags`, `contact_tags`, `custom_fields`, `contact_custom_values`.
   - `conversations`, `messages`, `message_reactions`, `pending_message_statuses`.
   - `message_templates`, `quick_replies`.
   - `flows`, `flow_nodes` (supporting `api_request`), `flow_runs`, `flow_run_events`.
   - `automations`, `automation_steps`, `automation_logs`, `automation_pending_executions`.
   - `api_keys`, `webhook_endpoints`, `notifications`.
   - Stored functions: `bump_conversation_on_inbound`, `filter_contacts_by_tags`, `replace_flow_nodes`, `increment_flow_execution_count`.
5. Copy your Neon connection string into `DATABASE_URL`:
   ```
   DATABASE_URL=postgresql://<user>:<password>@<ep-pooler>.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```

---

## 3. Meta WhatsApp Cloud API Setup

### A. Obtain a Permanent System User Token
1. In Meta Business Manager, go to **Business Settings → Users → System Users**.
2. Add a System User with the **Admin** role.
3. Click **Generate New Token**.
4. Select your WhatsApp Business App.
5. Select permissions:
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
6. Set expiration to **Never**. Copy this value as `META_ACCESS_TOKEN`.

### B. Retrieve IDs & Secret
- **Phone Number ID**: WhatsApp Manager → API Setup → Phone number ID.
- **WABA ID**: WhatsApp Manager → API Setup → WhatsApp Business Account ID.
- **Meta App Secret**: Meta for Developers → App Settings → Basic → App Secret.

---

## 4. Local Development & ngrok Webhook Testing

1. Start your local WACRM application:
   ```bash
   npm run dev
   ```
   WACRM starts on `http://localhost:3000`.

2. In a separate terminal, expose port 3000 using ngrok:
   ```bash
   ngrok http 3000
   ```
   Copy the HTTPS forwarding address (e.g. `https://abcd-1234.ngrok-free.app`).

3. Configure your local `.env.local`:
   ```env
   WACRM_APP_URL=https://abcd-1234.ngrok-free.app
   META_WEBHOOK_VERIFY_TOKEN=my_custom_verify_token_123
   ```

4. Configure the Webhook in Meta for Developers:
   - Go to **WhatsApp → Configuration → Callback URL**.
   - Set URL: `https://abcd-1234.ngrok-free.app/api/whatsapp/webhook`
   - Set Verify Token: `my_custom_verify_token_123`
   - Click **Verify and Save**.
   - Under **Webhook fields**, click **Manage** and subscribe to:
     - `messages` (for inbound messages, media, and quick-reply taps)
     - `message_template_status_update` (for template status changes)

---

## 5. Clerk Authentication Setup

1. Create a project at [Clerk](https://clerk.com).
2. Set up authentication methods (Email / Password or Google).
3. Copy your API keys to environment variables:
   ```env
   NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
   CLERK_SECRET_KEY=sk_test_...
   NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
   NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
   NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=/inbox
   NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL=/inbox
   ```
4. On first sign-in, WACRM automatically bootstraps the agent's account and profile in Neon PostgreSQL.

---

## 6. Application A (FastAPI) Integration

The integration router is added to FastAPI at `/api/v1/integrations/*` authenticated via `FASTAPI_SERVICE_TOKEN`.

### Endpoints
1. `GET /api/v1/integrations/policy?phone={phone}`
   - **Header**: `X-Service-Token: <FASTAPI_SERVICE_TOKEN>`
   - **Response**:
     ```json
     {
       "found": true,
       "customer_name": "Rahul Sharma",
       "phone": "9876543210",
       "has_active_renewal": true,
       "renewal_id": "uuid-here",
       "policy_number": "POL-987654",
       "vehicle_number": "MH12AB1234",
       "vehicle_make_model": "Honda City",
       "due_date": "2026-11-20",
       "gross_premium": 14250.0,
       "amount_paid": 0.0,
       "balance_due": 14250.0,
       "payment_link": "https://secure-pay.insurer.com/p/12345",
       "is_paid": false
     }
     ```

2. `GET /api/v1/integrations/document?renewal_id={renewal_id}`
   - **Header**: `X-Service-Token: <FASTAPI_SERVICE_TOKEN>`
   - **Response**:
     ```json
     {
       "renewal_id": "uuid-here",
       "document_url": "https://s3.eu-central-003.backblazeb2.com/bucket/proofs/..."
     }
     ```

---

## 7. Individual-Message REST API (`POST /api/v1/messages`)

Application A (or scheduled reminder scripts) sends messages through WACRM using this endpoint.

- **URL**: `POST https://<wacrm-domain>/api/v1/messages`
- **Headers**:
  - `Content-Type: application/json`
  - `Authorization: Bearer <WACRM_API_KEY>`

### Request Body (Template Message with Dynamic Parameters)
```json
{
  "to": "+919876543210",
  "name": "Rahul Sharma",
  "type": "template",
  "template": {
    "name": "renewal_reminder_utility",
    "language": "en_US",
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

### Request Body (Individual Text Message)
```json
{
  "to": "+919876543210",
  "type": "text",
  "text": "Hello Rahul, your policy renewal notice is ready for download."
}
```

### Response (201 Created)
```json
{
  "data": {
    "message_id": "uuid-stored-in-db",
    "whatsapp_message_id": "wamid.HBgL...",
    "conversation_id": "uuid-conversation",
    "contact_id": "uuid-contact",
    "contact_created": false
  }
}
```

---

## 8. Workflow Architecture & Behavior

The application implements a clean, simplified workflow architecture supporting exactly two workflow types with strict precedence:

### A. Dedicated API-Integrated Workflow: "Renewals on My Number"
- **Trigger**: `Renewals on My Number` (case-insensitive, trims edge punctuation and whitespace).
- **Security**: Calls Application A (FastAPI) via secure server-side authenticated HTTPS using `FASTAPI_SERVICE_TOKEN` (`X-Service-Token` and `Authorization: Bearer`).
- **Endpoint**: `GET /api/v1/integrations/renewals-by-phone?phone={verified_phone}`
- **Formatting**:
  - Numbered list of registered vehicles and models.
  - Payment status: `✅ Payment completed`, `⏳ Payment partial`, or `⏳ Payment pending`.
  - Balance due formatted in Indian Rupees (₹) when pending/partial.
  - Valid customer-facing payment links only.
  - Valid policy document URLs with enforced 5-minute expiry warning appended when documents exist.
- **Error Handling**: Graceful fallback without exposing internal URLs or server errors.

### B. Client-Configurable Trigger-and-Reply Workflows
- **Location**: Manageable directly in `/flows`.
- **Configuration**: Client specifies trigger keywords and the desired reply message.
- **Execution**: Stored as clean workflow rows (`flows` table) and executed automatically via the flow engine.
- **Enable/Disable**: Toggled with active/disabled status.

### C. Inbound Message Precedence & Fallback Hierarchy
When an inbound message arrives, it is processed through strict precedence:
1. **`Renewals on My Number` Trigger**: Executes the dedicated FastAPI vehicle lookup.
2. **Active Client Workflows**: Matches enabled trigger keywords and sends the configured reply.
3. **Menu Request (`MENU`, `OPTIONS`, `HELP`)**: Responds with the active services menu (including `Renewals on My Number` and all active client workflows).
4. **Greeting (`HI`, `HELLO`, `HEY`, `HLO`, etc.)**: Responds with a polite welcome message and the active services menu.
5. **Disabled Workflows Exclusion**: Workflows not in `active` status are strictly excluded from execution and the menu.
6. **Unrecognized Message Fallback**: Inbound messages that do not match any workflow or trigger receive a helpful guidance message directing them to `MENU` or `Renewals on My Number`.

---

## 9. Netlify Free Deployment

1. Connect your GitHub repository to Netlify.
2. Build Settings:
   - **Framework**: Next.js
   - **Build Command**: `npm run build`
   - **Publish directory**: `.next`
3. Environment Variables:
   Add all variables defined in `.env.example` in **Site Configuration → Environment Variables**.
4. Configure Cron Pinger (for Workflow Wait steps):
   Use a free service like [Cron-Job.org](https://cron-job.org) or Netlify Scheduled Functions to ping:
   ```
   POST https://<wacrm-site>.netlify.app/api/flows/cron
   Headers:
     Authorization: Bearer <FLOW_CRON_SECRET>
   ```
   Interval: Every 5 or 10 minutes.

---

## 10. Credential Rotation & Rollback Plan

### Credential Rotation Procedure
- **Meta Permanent Access Token**:
  1. Generate a new System User Token in Meta Business Manager.
  2. Update `META_ACCESS_TOKEN` in Netlify environment variables.
  3. Netlify automatically redeploys. No database or frontend changes needed.
- **Meta App Secret / Webhook Verify Token**:
  1. Update `META_APP_SECRET` and `META_WEBHOOK_VERIFY_TOKEN` in Netlify.
  2. Update Callback URL verification token in Meta for Developers dashboard.
- **WACRM API Key**:
  1. Update `WACRM_API_KEY` in Netlify environment variables.
  2. Update the corresponding key in FastAPI's environment.

### Rollback Plan
- The original fork is preserved on git branch `main`.
- All customization is committed cleanly to branch `custom/insurance-inbox`.
- To rollback code changes:
  ```bash
  git checkout main
  ```
- To backup or export Neon database:
  ```bash
  pg_dump "$DATABASE_URL" > wacrm_backup.sql
  ```

---

## 11. Hardcoded Trigger: "Renewals on My Number"

### How It Works
1. **Trigger Matching**:
   - Matches incoming WhatsApp messages matching `"Renewals on My Number"` (case-insensitive, handles whitespace and leading/trailing punctuation).
   - Rejects unrelated or conversational sentences containing similar words.
2. **Verified Sender Identification**:
   - Uses the Meta-verified incoming WhatsApp sender phone number (`message.from` / `contact.phone`).
   - Does NOT trust arbitrary numbers provided in the text.
3. **FastAPI Lookup**:
   - Queries `GET /api/v1/integrations/renewals-by-phone?phone={phone}` with `X-Service-Token`.
   - Returns structured JSON of all registered vehicles and their latest renewals.
4. **Response Formatting**:
   ```
   Your Vehicle Renewal Details

   1. AP20BA1232 – Model
   Payment status: ✅ Payment completed
   Policy document: [actual document URL]

   2. AP22BC1222 – Model
   Payment status: ⏳ Payment pending
   Balance due: ₹12,500
   Payment link: [actual customer-facing payment URL]

   ⚠️ Policy document links expire in 5 minutes. Please download your document immediately.
   ```
5. **Genuinely Expiring Document Links**:
   - Policy document URLs route through `/api/v1/integrations/document-download?token={token}` using an HMAC-SHA256 signature and a 300-second expiration.
   - When accessed after 5 minutes, returns `HTTP 410 Gone` with instructions to request a fresh link.
   - The expiry notice is appended **only** when at least one policy document link is present in the response.
6. **Client-Configurable Triggers**:
   - All other keyword triggers (e.g. greetings, address, website) remain fully configurable by the client via the visual Flow Builder (`/flows`) without touching code.

