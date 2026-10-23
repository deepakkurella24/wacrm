import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  interpolateFlowString,
  getByPath,
  executeApiRequestNode,
} from "./engine";
import type { ApiRequestNodeConfig, FlowNodeRow, FlowRunRow } from "./types";

describe("Workflow api_request: interpolateFlowString", () => {
  it("interpolates simple vars", () => {
    const res = interpolateFlowString("Hello {{vars.name}}!", { name: "John" });
    expect(res).toBe("Hello John!");
  });

  it("interpolates nested dot-path vars", () => {
    const res = interpolateFlowString("Policy: {{vars.policy.number}}", {
      policy: { number: "POL-12345" },
    });
    expect(res).toBe("Policy: POL-12345");
  });

  it("interpolates contact fields", () => {
    const res = interpolateFlowString(
      "Customer {{contact.name}} with phone {{contact.phone}}",
      {},
      { name: "Alice", phone: "9876543210" },
    );
    expect(res).toBe("Customer Alice with phone 9876543210");
  });

  it("replaces missing keys with empty string", () => {
    const res = interpolateFlowString(
      "Missing: '{{vars.missing}}' and '{{contact.missing}}'",
      {},
      null,
    );
    expect(res).toBe("Missing: '' and ''");
  });
});

describe("Workflow api_request: getByPath", () => {
  const data = {
    customer_name: "Rahul Sharma",
    policy: {
      number: "POL-9999",
      premium: {
        gross: 15000,
      },
    },
    vehicles: [
      { reg: "MH12AB1234", make: "Honda" },
      { reg: "MH12CD5678", make: "Hyundai" },
    ],
  };

  it("extracts root fields", () => {
    expect(getByPath(data, "customer_name")).toBe("Rahul Sharma");
  });

  it("extracts nested objects", () => {
    expect(getByPath(data, "policy.number")).toBe("POL-9999");
    expect(getByPath(data, "policy.premium.gross")).toBe(15000);
  });

  it("extracts array elements", () => {
    expect(getByPath(data, "vehicles[0].reg")).toBe("MH12AB1234");
    expect(getByPath(data, "vehicles[1].make")).toBe("Hyundai");
  });

  it("returns undefined for non-existent path", () => {
    expect(getByPath(data, "policy.missing.field")).toBeUndefined();
    expect(getByPath(data, "vehicles[5].reg")).toBeUndefined();
  });
});

describe("Workflow api_request: executeApiRequestNode", () => {
  const originalFetch = globalThis.fetch;
  const mockDb = {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: "c1", phone: "9876543210", name: "Rahul", email: "rahul@test.com" },
      }),
      insert: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({}),
      }),
    }),
  } as any;

  const mockRun: FlowRunRow = {
    id: "run-1",
    flow_id: "flow-1",
    account_id: "acc-1",
    user_id: "user-1",
    contact_id: "c1",
    conversation_id: "conv-1",
    status: "active",
    current_node_key: "node-api",
    transition_seq: 0,
    last_prompt_message_id: null,
    vars: {},
    reprompt_count: 0,
    started_at: new Date().toISOString(),
    last_advanced_at: new Date().toISOString(),
    ended_at: null,
    end_reason: null,
  };

  const mockNode: FlowNodeRow = {
    id: "n1",
    flow_id: "flow-1",
    node_key: "node-api",
    node_type: "api_request",
    config: {},
    position_x: 0,
    position_y: 0,
    created_at: new Date().toISOString(),
  };

  beforeEach(() => {
    process.env.FASTAPI_BASE_URL = "https://api.insurance.local";
    process.env.FASTAPI_SERVICE_TOKEN = "secret-service-token";
    process.env.WORKFLOW_ALLOWED_HOSTS = "api.insurance.local";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("executes HTTP GET, injects X-Service-Token for FastAPI, maps response vars, and advances to success_next", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({
        policy_number: "POL-777",
        balance_due: 12500,
        due_date: "2026-11-15",
      }),
    });
    globalThis.fetch = fetchMock;

    const cfg: ApiRequestNodeConfig = {
      method: "GET",
      url: "https://api.insurance.local/api/v1/integrations/policy?phone={{contact.phone}}",
      response_mapping: {
        policy_no: "policy_number",
        due: "balance_due",
      },
      success_next: "node-send-reminder",
      failure_next: "node-error",
    };

    const res = await executeApiRequestNode(mockDb, { ...mockRun, vars: {} } as any, mockNode, cfg);

    expect(res.next_node_key).toBe("node-send-reminder");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledOpts] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe("https://api.insurance.local/api/v1/integrations/policy?phone=9876543210");
    expect(calledOpts.headers["X-Service-Token"]).toBe("secret-service-token");
  });

  it("branches to failure_next on HTTP 500 error", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      headers: new Headers(),
    });
    globalThis.fetch = fetchMock;

    const cfg: ApiRequestNodeConfig = {
      method: "GET",
      url: "https://api.insurance.local/api/v1/integrations/policy?phone={{contact.phone}}",
      success_next: "node-success",
      failure_next: "node-fallback",
    };

    const res = await executeApiRequestNode(mockDb, { ...mockRun, vars: {} } as any, mockNode, cfg);
    expect(res.next_node_key).toBe("node-fallback");
  });

  it("branches to failure_next on network exception or timeout", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Connection refused"));

    const cfg: ApiRequestNodeConfig = {
      method: "GET",
      url: "https://api.insurance.local/api/v1/integrations/policy",
      success_next: "node-success",
      failure_next: "node-fallback",
    };

    const res = await executeApiRequestNode(mockDb, { ...mockRun, vars: {} } as any, mockNode, cfg);
    expect(res.next_node_key).toBe("node-fallback");
  });
});
