# 1. Setup & Deployment Guide

This guide walks you through setting up the database, authentication, Meta WhatsApp Cloud API, environment variables, local testing, and production deployment on Netlify.

---

## 1. Database Setup (Neon PostgreSQL)

WACRM maintains its own dedicated Neon PostgreSQL database (separate from Application A's insurance database).

1. Log in to [Neon](https://neon.tech) and create a new project (e.g. `wacrm-inbox`).
2. Open the **SQL Editor** in your Neon dashboard.
3. Open [`neon_schema.sql`](../neon_schema.sql) in this repository, copy its full contents, paste into the Neon SQL editor, and click **Run**.
4. Apply the media storage migration:
   - Run the script in [`migrations/001_add_media_columns.sql`](../migrations/001_add_media_columns.sql).
5. Copy your connection string:
   ```env
   DATABASE_URL=postgresql://neondb_owner:password@ep-cool-sample-123456.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```

---

## 2. Clerk Authentication Setup

Agent sign-in and session security are handled via Clerk:

1. Create a project at [Clerk](https://clerk.com).
2. Configure your desired sign-in methods (Email + Password or Google).
3. Copy the API keys:
   ```env
   NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
   CLERK_SECRET_KEY=sk_test_...
   NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
   NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
   NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=/inbox
   NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL=/inbox
   ```
4. On first sign-in, WACRM automatically bootstraps the user profile and primary account row in Neon.

---

## 3. Meta WhatsApp Cloud API Setup

All Meta credentials are read securely on the server via environment variables.

### A. Obtain a Permanent System User Token
1. In Meta Business Manager, go to **Business Settings → Users → System Users**.
2. Click **Add** and create a system user with the **Admin** role.
3. Click **Generate New Token**.
4. Select your WhatsApp App and select the following permissions:
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
5. Set token expiration to **Never**. Copy this value as `META_ACCESS_TOKEN`.

### B. Retrieve IDs and Secrets
- **Phone Number ID**: WhatsApp Manager → API Setup → Phone number ID.
- **WABA ID**: WhatsApp Manager → API Setup → WhatsApp Business Account ID.
- **App Secret**: Meta for Developers → App Settings → Basic → App Secret.
- **Webhook Verify Token**: Any secure random string you choose (e.g. `69f2e700670a50c3718b0b79e568c714`).

---

## 4. Environment Variables Reference

Create a `.env` file in the root of the `WACRM/` project (mirrored from `.env.example`):

```env
# ------------------------------------------------------------
# 1. Meta WhatsApp Cloud API (Server-Side)
# ------------------------------------------------------------
META_ACCESS_TOKEN=EAAG...permanent_system_user_token
META_PHONE_NUMBER_ID=100000000000000
META_WABA_ID=200000000000000
META_APP_SECRET=0123456789abcdef0123456789abcdef
META_WEBHOOK_VERIFY_TOKEN=69f2e700670a50c3718b0b79e568c714
META_GRAPH_API_VERSION=v22.0

# ------------------------------------------------------------
# 2. Database & Application URLs
# ------------------------------------------------------------
DATABASE_URL=postgresql://neondb_owner:password@ep-cool-sample.us-east-2.aws.neon.tech/neondb?sslmode=require
WACRM_APP_URL=http://localhost:3000

# ------------------------------------------------------------
# 3. Machine-to-Machine Service Keys
# ------------------------------------------------------------
WACRM_SERVICE_API_KEY=wacrm_live_24ZDoS2AovuKc9iDQTDmVk8LkmqbksGzNATUYCFImFw
WACRM_API_KEY=wacrm_live_24ZDoS2AovuKc9iDQTDmVk8LkmqbksGzNATUYCFImFw
FASTAPI_BASE_URL=http://localhost:8000
FASTAPI_SERVICE_TOKEN=5c559c5ce73b673e95dc9003c35ce04541aa4059c6e5df68
WORKFLOW_ALLOWED_HOSTS=localhost,127.0.0.1,insurance-backend.onrender.com

ENCRYPTION_KEY=0b92da3a40cb5965f6b916920581e125523577d38a79a6c632cbae15f70c2397
FLOW_CRON_SECRET=14b5fb8a1b4de244bd121cd4dc8044f6b5d074346d6da9cb

# ------------------------------------------------------------
# 4. Clerk Authentication
# ------------------------------------------------------------
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=/inbox
NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL=/inbox
```

---

## 5. Local Development & Webhook Testing with ngrok

1. **Install dependencies and run**:
   ```bash
   npm install
   npm run dev
   ```
   WACRM starts on `http://localhost:3000`.

2. **Expose port 3000 via ngrok**:
   ```bash
   ngrok http 3000
   ```
   Copy the assigned HTTPS address (e.g. `https://abcd-1234.ngrok-free.app`).

3. **Configure Meta Webhook**:
   - In Meta for Developers, go to **WhatsApp → Configuration → Callback URL**.
   - **URL**: `https://showy-obstruct-suction.ngrok-free.dev/api/whatsapp/webhook`
   - **Verify Token**: Must match `META_WEBHOOK_VERIFY_TOKEN` in your `.env`.
   - Click **Verify and Save**.
   - Under **Webhook fields**, click **Manage** and subscribe to:
     - `messages`
     - `message_template_status_update`

---

## 6. Netlify Production Deployment

1. Push your changes to GitHub on branch `custom/insurance-inbox`.
2. In Netlify, click **Add new site → Import an existing project**.
3. Select your repository and specify:
   - **Base directory**: `WACRM`
   - **Build command**: `npm run build`
   - **Publish directory**: `.next`
4. Add all environment variables from your `.env` file under **Site Configuration → Environment Variables**.
5. Once deployed, update your Meta Webhook Callback URL to your production domain:
   `https://<your-site>.netlify.app/api/whatsapp/webhook`.
6. Configure a periodic cron ping (e.g. via [Cron-Job.org](https://cron-job.org) every 5 minutes):
   ```http
   POST https://<your-site>.netlify.app/api/flows/cron
   Authorization: Bearer <FLOW_CRON_SECRET>
   ```
