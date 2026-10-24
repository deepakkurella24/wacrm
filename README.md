# WACRM — Insurance WhatsApp Inbox Edition

> Customized, lightweight WhatsApp Inbox and workflow engine tailored for insurance agency operations. Powered by Next.js, Neon PostgreSQL, Clerk Authentication, Backblaze B2, and the official Meta WhatsApp Cloud API.

---

## What This Customized Edition Does

- **Dedicated Shared Inbox**: Manage customer WhatsApp conversations with the official Meta WhatsApp Cloud API.
- **Fixed Machine-to-Machine Integration**: Pre-authenticated `POST /api/v1/messages` endpoint used by the FastAPI insurance backend to send reminder messages and policy documents.
- **Automated "Renewals on My Number" Workflow**: Inbound trigger that automatically verifies customer phone numbers, fetches vehicle and renewal status from the FastAPI backend, and replies with structured renewal details, payment links, and temporary expiring policy documents.
- **Client-Configurable Workflows (`/flows`)**: Visual builder for custom keyword triggers and auto-replies (e.g. office address, claims help, business hours).
- **Backblaze B2 Media Integration**: Incoming customer photos, PDFs, and voice messages stream securely into private Backblaze B2 object storage via FastAPI presigned URLs without storing credentials in the browser or WACRM.
- **Clean Security**: All Meta tokens, app secrets, and service keys are managed server-side via environment variables. Client-side API key and WhatsApp connection management forms have been removed.

---

## Technology Stack

- **Framework**: Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS
- **Database**: Neon PostgreSQL with server-side pooling
- **Authentication**: Clerk (agent accounts & secure sessions)
- **Object Storage**: Backblaze B2 (private bucket via FastAPI presigned URLs)
- **WhatsApp API**: Official Meta WhatsApp Cloud API (Graph API v22.0)
- **Companion Backend**: FastAPI Insurance Management Application

---

## Documentation

Comprehensive documentation is available in the [`docs/`](./docs) folder:

1. [**System Overview & Architecture**](./docs/README.md) — High-level architecture, component interactions, and security boundaries.
2. [**Setup & Deployment Guide**](./docs/01-setup-and-deployment.md) — Step-by-step instructions for Neon database, Clerk auth, Meta Cloud API, local ngrok testing, and Netlify deployment.
3. [**Workflows & Messaging Guide**](./docs/02-workflows-and-messaging.md) — Inbound message precedence, `Renewals on My Number` trigger specifications, client flows, and Backblaze B2 incoming media handling.
4. [**Fixed Server-to-Server API Integration**](./docs/03-fixed-api-integration.md) — `POST /api/v1/messages` endpoint specification, least-privilege scoping, and FastAPI Python client usage.
5. [**Troubleshooting Guide**](./docs/04-troubleshooting.md) — Common error resolutions for Meta webhooks, token expiration, FastAPI connectivity, and media uploads.

---

## Quick Start (Local Development)

1. Clone or navigate to the repository:
   ```bash
   cd WACRM
   npm install
   ```

2. Configure environment variables:
   ```bash
   cp .env.example .env
   # Fill in DATABASE_URL (Neon), CLERK_* keys, and META_* credentials
   ```

3. Run the development server:
   ```bash
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000) to view the application.

4. Expose the webhook locally:
   ```bash
   ngrok http 3000
   ```
   Configure the callback URL in the Meta Developer Portal as `https://<ngrok-id>.ngrok-free.app/api/whatsapp/webhook`.

---

## License

[MIT](./LICENSE)
