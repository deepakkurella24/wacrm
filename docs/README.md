# WACRM — Insurance WhatsApp Inbox Documentation

Welcome to the documentation for the customized **Insurance WhatsApp Inbox** edition of WACRM.

This application serves as a dedicated WhatsApp conversation hub and workflow engine for an insurance agency, working seamlessly alongside the authoritative **FastAPI Insurance Management Application**.

---

## Architecture Overview

```
┌──────────────────────────────────────┐          ┌──────────────────────────────────────┐
│ Application A: Insurance Backend     │          │ Application B: Customized WACRM     │
│ (FastAPI on Render Free)             │          │ (Next.js App Router on Netlify Free) │
│ - Neon PostgreSQL (Project A)        │          │ - Neon PostgreSQL (Project B)        │
│ - Authoritative Insurance Database   │          │ - Clerk Authentication               │
│ - Policy, vehicle, renewal records   │          │ - Inbox, Conversations, Workflows    │
│ - Backblaze B2 Object Storage        │          │ - Backblaze B2 Media Integration     │
└──────────────────┬───────────────────┘          └──────────────────┬───────────────────┘
                   │                                                 │
                   │ Authenticated HTTPS (FASTAPI_SERVICE_TOKEN)     │ Direct Meta Cloud API
                   │                                                 │ (META_ACCESS_TOKEN)
                   ▼                                                 ▼
     ┌───────────────────────────┐                     ┌───────────────────────────┐
     │ FastAPI Integration Router│                     │ Official Meta WhatsApp    │
     │ /api/v1/integrations/*    │                     │ Cloud API (Graph v22.0)   │
     │ /api/v1/storage/*         │                     └───────────────────────────┘
     └───────────────────────────┘
```

### Technology Stack
- **Frontend / Fullstack**: Next.js 16 (App Router), React, Tailwind CSS, TypeScript
- **Database**: Neon PostgreSQL (Project B) with server-side pooling
- **Authentication**: Clerk (agent accounts & secure session management)
- **Object Storage**: Backblaze B2 (managed via FastAPI backend presigned URLs)
- **WhatsApp Provider**: Official Meta WhatsApp Cloud API (Graph v22.0)
- **Deployment**: Netlify Free (Frontend/SSR) + Render Free (FastAPI Backend)

---

## Documentation Index

| Guide | Description |
|---|---|
| [**1. Setup & Deployment**](./01-setup-and-deployment.md) | Database schema setup, Clerk auth, Meta WhatsApp setup, environment variables, local testing, and Netlify deployment. |
| [**2. Workflows & Messaging**](./02-workflows-and-messaging.md) | Detailed explanation of the `Renewals on My Number` hardcoded trigger, client flows, message precedence, and Backblaze B2 media storage. |
| [**3. Fixed API Integration**](./03-fixed-api-integration.md) | Fixed server-to-server Public API (`POST /api/v1/messages`), authentication, and FastAPI Python client usage. |
| [**4. Troubleshooting**](./04-troubleshooting.md) | Solutions for Meta webhook errors, token expiration, FastAPI connection failures, and media storage issues. |
