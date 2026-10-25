import { describe, expect, it, vi } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

// Mock @clerk/nextjs/server
const mockAuth = vi.fn();

vi.mock("@clerk/nextjs/server", () => ({
  clerkMiddleware: (handler: any) => {
    return async (request: any, _event?: any) => {
      return handler(mockAuth, request);
    };
  },
  createRouteMatcher: (patterns: string[]) => {
    return (req: any) => {
      const url = new URL(req.url);
      const path = url.pathname;
      return patterns.some((p) => {
        if (p.endsWith('(.*)')) {
          const prefix = p.replace('(.*)', '');
          return path.startsWith(prefix);
        }
        return path === p;
      });
    };
  },
}));

import middleware from "./middleware";

const dummyEvent = {} as any;

describe("Clerk Middleware — Route Protection", () => {
  const dashboardRoutes = readdirSync(join(__dirname, "app", "(dashboard)"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `/${entry.name}`);

  it("identifies remaining dashboard routes", () => {
    expect(dashboardRoutes).toContain("/inbox");
    expect(dashboardRoutes).toContain("/contacts");
    expect(dashboardRoutes).toContain("/flows");
    expect(dashboardRoutes).toContain("/settings");
  });

  it("allows public webhook routes without authentication", async () => {
    mockAuth.mockResolvedValue({ userId: null });
    const req = new NextRequest("https://app.test/api/whatsapp/webhook");
    const res = await middleware(req, dummyEvent);
    expect(res?.status).toBe(200);
  });

  it("allows public API v1 routes without Clerk session (uses API keys)", async () => {
    mockAuth.mockResolvedValue({ userId: null });
    const req = new NextRequest("https://app.test/api/v1/messages");
    const res = await middleware(req, dummyEvent);
    expect(res?.status).toBe(200);
  });

  it("allows public sign-in and sign-up pages without authentication", async () => {
    mockAuth.mockResolvedValue({ userId: null });
    const req1 = new NextRequest("https://app.test/sign-in");
    const res1 = await middleware(req1, dummyEvent);
    expect(res1?.status).toBe(200);

    const req2 = new NextRequest("https://app.test/sign-up");
    const res2 = await middleware(req2, dummyEvent);
    expect(res2?.status).toBe(200);
  });

  it("allows public icon and favicon assets without authentication", async () => {
    mockAuth.mockResolvedValue({ userId: null });
    const req1 = new NextRequest("https://app.test/icon");
    const res1 = await middleware(req1, dummyEvent);
    expect(res1?.status).toBe(200);

    const req2 = new NextRequest("https://app.test/favicon.ico");
    const res2 = await middleware(req2, dummyEvent);
    expect(res2?.status).toBe(200);
  });

  it.each(dashboardRoutes)("redirects unauthenticated visitor from %s to sign-in", async (route) => {
    const redirectToSignIn = vi.fn().mockReturnValue({
      status: 307,
      headers: new Headers({ location: "https://app.test/sign-in" }),
    });
    mockAuth.mockResolvedValue({ userId: null, redirectToSignIn });

    const req = new NextRequest(`https://app.test${route}`);
    const res = await middleware(req, dummyEvent);

    expect(redirectToSignIn).toHaveBeenCalled();
    expect(res?.status).toBe(307);
  });

  it("returns 401 for unauthenticated internal API requests", async () => {
    mockAuth.mockResolvedValue({ userId: null });
    const req = new NextRequest("https://app.test/api/contacts");
    const res = await middleware(req, dummyEvent);
    expect(res?.status).toBe(401);
  });

  it("allows authenticated user to access protected routes", async () => {
    mockAuth.mockResolvedValue({ userId: "user_123" });
    const req = new NextRequest("https://app.test/inbox");
    const res = await middleware(req, dummyEvent);
    expect(res?.status).toBe(200);
  });
});
