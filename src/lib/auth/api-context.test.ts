import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { generateApiKey } from "@/lib/api-keys/keys";
import type { ApiKeyRow } from "@/lib/api-keys/store";
import { ApiError } from "@/lib/api/v1/respond";
import { __resetRateLimitForTests, RATE_LIMITS } from "@/lib/rate-limit";

// Mock the service-role client factory — requireApiKey only stashes
// the returned client in the context; tests never call through it.
vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({ __isMockAdminClient: true }),
}));

// Mock the store so we control which row a hash resolves to.
const findActiveKeyByHash = vi.fn<(hash: string) => Promise<ApiKeyRow | null>>();
const getOrProvisionFixedServiceKey = vi.fn<
  (keyHash: string, keyPrefix: string) => Promise<{ id: string; accountId: string } | null>
>();
const touchLastUsed = vi.fn();

vi.mock("@/lib/api-keys/store", () => ({
  findActiveKeyByHash: (hash: string) => findActiveKeyByHash(hash),
  getOrProvisionFixedServiceKey: (hash: string, prefix: string) =>
    getOrProvisionFixedServiceKey(hash, prefix),
  touchLastUsed: (id: string) => touchLastUsed(id),
}));

// Import AFTER the mocks are registered.
const { requireApiKey, __resetFixedKeyCacheForTests } = await import("./api-context");

const KEY = generateApiKey().plaintext;
const SERVER_KEY = "wacrm_live_server_secret_test_key_123456789";

function reqWith(authHeader?: string): Request {
  return new Request("https://crm.example.com/api/v1/messages", {
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

function row(overrides: Partial<ApiKeyRow> = {}): ApiKeyRow {
  return {
    id: "key-1",
    account_id: "acct-1",
    created_by: "user-1",
    name: "Test key",
    scopes: ["messages:send"],
    expires_at: null,
    revoked_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  __resetRateLimitForTests();
  __resetFixedKeyCacheForTests();
  findActiveKeyByHash.mockReset();
  getOrProvisionFixedServiceKey.mockReset();
  touchLastUsed.mockReset();
  delete process.env.WACRM_SERVICE_API_KEY;
  delete process.env.WACRM_API_KEY;
});

afterEach(() => {
  __resetRateLimitForTests();
  __resetFixedKeyCacheForTests();
  delete process.env.WACRM_SERVICE_API_KEY;
  delete process.env.WACRM_API_KEY;
});

async function expectApiError(p: Promise<unknown>, code: string, status: number) {
  await expect(p).rejects.toBeInstanceOf(ApiError);
  await p.catch((e: unknown) => {
    const err = e as ApiError;
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
  });
}

describe("requireApiKey - Database API keys", () => {
  it("401s when no Authorization header is present", async () => {
    await expectApiError(requireApiKey(reqWith()), "unauthorized", 401);
    expect(findActiveKeyByHash).not.toHaveBeenCalled();
  });

  it("401s on a token that doesn't look like a wacrm key", async () => {
    await expectApiError(
      requireApiKey(reqWith("Bearer some-invite-token")),
      "unauthorized",
      401,
    );
    expect(findActiveKeyByHash).not.toHaveBeenCalled();
  });

  it("401s when the key is unknown / revoked / expired (store returns null)", async () => {
    findActiveKeyByHash.mockResolvedValue(null);
    await expectApiError(
      requireApiKey(reqWith(`Bearer ${KEY}`)),
      "unauthorized",
      401,
    );
  });

  it("returns a context for a valid key with no scope required", async () => {
    findActiveKeyByHash.mockResolvedValue(row());
    const ctx = await requireApiKey(reqWith(`Bearer ${KEY}`));
    expect(ctx.authType).toBe("api_key");
    expect(ctx.accountId).toBe("acct-1");
    expect(ctx.keyId).toBe("key-1");
    expect(ctx.scopes).toEqual(["messages:send"]);
    expect(touchLastUsed).toHaveBeenCalledWith("key-1");
  });

  it("accepts a bare key without the 'Bearer ' prefix", async () => {
    findActiveKeyByHash.mockResolvedValue(row());
    const ctx = await requireApiKey(reqWith(KEY));
    expect(ctx.accountId).toBe("acct-1");
  });

  it("403s when the key lacks the required scope", async () => {
    findActiveKeyByHash.mockResolvedValue(row({ scopes: ["contacts:read"] }));
    await expectApiError(
      requireApiKey(reqWith(`Bearer ${KEY}`), "messages:send"),
      "forbidden",
      403,
    );
  });

  it("passes when the key has the required scope", async () => {
    findActiveKeyByHash.mockResolvedValue(row({ scopes: ["messages:send"] }));
    const ctx = await requireApiKey(reqWith(`Bearer ${KEY}`), "messages:send");
    expect(ctx.accountId).toBe("acct-1");
  });

  it("429s once the per-key budget is exhausted", async () => {
    findActiveKeyByHash.mockResolvedValue(row());
    for (let i = 0; i < RATE_LIMITS.publicApi.limit; i++) {
      await requireApiKey(reqWith(`Bearer ${KEY}`));
    }
    await expectApiError(
      requireApiKey(reqWith(`Bearer ${KEY}`)),
      "rate_limited",
      429,
    );
  });
});

describe("requireApiKey - Fixed server-side service key", () => {
  it("authenticates valid server key configured via WACRM_SERVICE_API_KEY", async () => {
    process.env.WACRM_SERVICE_API_KEY = SERVER_KEY;
    getOrProvisionFixedServiceKey.mockResolvedValue({
      id: "srv-key-1",
      accountId: "srv-acct-1",
    });

    const ctx = await requireApiKey(reqWith(`Bearer ${SERVER_KEY}`), "messages:send");
    expect(ctx.authType).toBe("api_key");
    expect(ctx.accountId).toBe("srv-acct-1");
    expect(ctx.keyId).toBe("srv-key-1");
    expect(ctx.scopes).toEqual(["messages:send"]);
    expect(touchLastUsed).toHaveBeenCalledWith("srv-key-1");
  });

  it("authenticates valid server key configured via WACRM_API_KEY fallback", async () => {
    process.env.WACRM_API_KEY = SERVER_KEY;
    getOrProvisionFixedServiceKey.mockResolvedValue({
      id: "srv-key-2",
      accountId: "srv-acct-2",
    });

    const ctx = await requireApiKey(reqWith(`Bearer ${SERVER_KEY}`));
    expect(ctx.accountId).toBe("srv-acct-2");
    expect(ctx.keyId).toBe("srv-key-2");
    expect(ctx.scopes).toEqual(["messages:send"]);
  });

  it("enforces least-privilege 403 forbidden for scopes other than messages:send", async () => {
    process.env.WACRM_SERVICE_API_KEY = SERVER_KEY;
    getOrProvisionFixedServiceKey.mockResolvedValue({
      id: "srv-key-1",
      accountId: "srv-acct-1",
    });

    await expectApiError(
      requireApiKey(reqWith(`Bearer ${SERVER_KEY}`), "contacts:write" as any),
      "forbidden",
      403,
    );
  });

  it("rejects an incorrect key attempting to impersonate server key", async () => {
    process.env.WACRM_SERVICE_API_KEY = SERVER_KEY;
    findActiveKeyByHash.mockResolvedValue(null);

    await expectApiError(
      requireApiKey(reqWith("Bearer wacrm_live_wrong_key_abcdef123456789")),
      "unauthorized",
      401,
    );
  });

  it("rate limits server key after budget exhaustion", async () => {
    process.env.WACRM_SERVICE_API_KEY = SERVER_KEY;
    getOrProvisionFixedServiceKey.mockResolvedValue({
      id: "srv-key-rate",
      accountId: "srv-acct-1",
    });

    for (let i = 0; i < RATE_LIMITS.publicApi.limit; i++) {
      await requireApiKey(reqWith(`Bearer ${SERVER_KEY}`), "messages:send");
    }

    await expectApiError(
      requireApiKey(reqWith(`Bearer ${SERVER_KEY}`), "messages:send"),
      "rate_limited",
      429,
    );
  });
});
