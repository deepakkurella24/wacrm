import type { SupabaseClient } from '@/lib/db';
import { sendMessageToConversation } from '@/lib/whatsapp/send-message';
import type { InteractiveListPayload } from '@/lib/whatsapp/interactive';

export interface VehicleRenewalItem {
  registration_number: string;
  model?: string | null;
  payment_status: 'PAID' | 'PARTIAL' | 'UNPAID' | 'NO_RENEWAL' | string;
  balance_due?: number | null;
  gross_premium?: number | null;
  amount_paid?: number | null;
  policy_document_url?: string | null;
  payment_url?: string | null;
}

export interface RenewalsApiResponse {
  found: boolean;
  customer_name?: string | null;
  phone?: string | null;
  message?: string | null;
  vehicles: VehicleRenewalItem[];
}

export interface ActiveWorkflowItem {
  id: string;
  name: string;
  keywords: string[];
}

/**
 * Clean incoming text: trim, lowercase, collapse whitespace, strip edge punctuation.
 */
export function cleanMessageText(rawText: string | null | undefined): string {
  if (!rawText) return '';
  return rawText
    .trim()
    .toLowerCase()
    .replace(/^[\s.,!?:;'"-]+|[\s.,!?:;'"-]+$/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Match the hardcoded trigger "Renewals on My Number".
 *
 * Rules:
 * - Case-insensitive
 * - Collapses multiple whitespaces into a single space
 * - Trims whitespace and strips common punctuation from ends
 * - Strict exact match: does not trigger on unrelated sentences containing the words
 */
export function isRenewalsTrigger(rawText: string | null | undefined): boolean {
  const cleaned = cleanMessageText(rawText);
  if (!cleaned) return false;
  return (
    cleaned === 'renewals on my number' ||
    cleaned === '1. renewals on my number' ||
    cleaned === '1'
  );
}

/**
 * Common greetings: hi, hello, hlo, hey, namaste, good morning, etc.
 */
const GREETINGS = new Set([
  'hi',
  'hello',
  'hlo',
  'hey',
  'namaste',
  'good morning',
  'good afternoon',
  'good evening',
]);

export function isGreeting(rawText: string | null | undefined): boolean {
  return GREETINGS.has(cleanMessageText(rawText));
}

/**
 * Menu trigger: MENU, options, help.
 */
const MENU_COMMANDS = new Set(['menu', 'options', 'help']);

export function isMenuTrigger(rawText: string | null | undefined): boolean {
  return MENU_COMMANDS.has(cleanMessageText(rawText));
}

/**
 * Retrieve enabled client-configured workflows from the database.
 * Disabled (draft / archived) workflows are excluded.
 */
export async function getActiveClientWorkflows(
  db: SupabaseClient,
  accountId: string,
): Promise<ActiveWorkflowItem[]> {
  const { data: flows, error } = await db
    .from('flows')
    .select('id, name, trigger_type, trigger_config, status')
    .eq('account_id', accountId)
    .eq('status', 'active')
    .order('created_at', { ascending: true });

  if (error || !flows) return [];

  return flows.map((f: any) => {
    const keywords: string[] =
      f.trigger_type === 'keyword' && Array.isArray(f.trigger_config?.keywords)
        ? f.trigger_config.keywords
        : [];
    return {
      id: f.id,
      name: f.name || 'Custom Workflow',
      keywords,
    };
  });
}

/**
 * Generate the available-actions menu.
 * - Always includes Option 1: "Renewals on My Number".
 * - Dynamically includes any active client-configured workflows.
 * - Excludes disabled workflows.
 */
export function formatMenuMessage(
  activeWorkflows: ActiveWorkflowItem[] = [],
  isGreetingMode = false,
): string {
  const lines: string[] = [];

  if (isGreetingMode) {
    lines.push('Hello! Welcome to our insurance service. How can we help you today?');
    lines.push('');
  }

  lines.push('Available Services:');
  lines.push('1. Renewals on My Number');

  let index = 2;
  activeWorkflows.forEach((wf) => {
    if (wf.name.toLowerCase() === 'renewals on my number') return;
    const label = wf.name || (wf.keywords.length > 0 ? wf.keywords[0] : `Service ${index}`);
    lines.push(`${index}. ${label}`);
    index += 1;
  });

  lines.push('');
  lines.push('Reply with any option above, or send MENU at any time to view this list.');

  return lines.join('\n');
}

/**
 * Generate a helpful fallback message for unrecognized input.
 */
/**
 * Build the interactive list menu payload for WhatsApp.
 * Header / body greeting users with PULI Insurance Services branding
 * and listing all active service workflows.
 */
export function buildInteractiveMenuPayload(
  activeWorkflows: ActiveWorkflowItem[] = [],
): InteractiveListPayload {
  const rows: Array<{ id: string; title: string }> = [
    {
      id: 'renewals_on_my_number',
      title: 'Renewals on My Number',
    },
  ];

  activeWorkflows.forEach((wf) => {
    const lower = wf.name.toLowerCase();
    if (lower === 'renewals on my number' || lower === 'welcome menu') return;
    const title = wf.name.slice(0, 24);
    const id = wf.keywords.length > 0 ? wf.keywords[0].slice(0, 200) : wf.id;
    rows.push({ id, title });
  });

  return {
    kind: 'list',
    body: 'Hello 👋,\nWelcome to PULI Insurance Services\n\nHow may I assist you today? Please select one from the below options 👇',
    button_label: 'Menu',
    sections: [
      {
        title: 'Our Services',
        rows: rows.slice(0, 10),
      },
    ],
  };
}

export function formatFallbackMessage(): string {
  return [
    "Thank you for your message! We couldn't recognize your request.",
    '',
    '• Reply with *MENU* to see available options.',
    '• Reply with *Renewals on My Number* to check your vehicle renewal status.',
    '',
    'Our agent has also been notified and will assist you shortly.',
  ].join('\n');
}

/**
 * Format a human-readable WhatsApp text message from the FastAPI renewals response.
 * Follows exact specifications:
 * - Numbered vehicle list
 * - Accurate payment status
 * - Balance due only when unpaid/partial and balance > 0
 * - Policy document link only when available
 * - Payment link only when unpaid/partial and available (customer-facing)
 * - Appends 5-minute expiry notice ONLY if at least one document link exists
 */
export function formatRenewalsReply(data: RenewalsApiResponse): string {
  if (!data.found || !data.vehicles || data.vehicles.length === 0) {
    return 'No registered vehicles or policy renewals were found for your phone number. If you believe this is an error, please reply here with your vehicle registration number.';
  }

  const lines: string[] = ['Your Vehicle Renewal Details'];
  let hasDocumentLink = false;

  data.vehicles.forEach((veh, index) => {
    lines.push(''); // Blank line separator
    const num = index + 1;
    const regNo = (veh.registration_number || 'UNKNOWN').trim();
    const model = (veh.model || '').trim();
    const header = model && model.toLowerCase() !== 'model' ? `${num}. ${regNo} – ${model}` : `${num}. ${regNo} – Model`;
    lines.push(header);
    lines.push('');

    const statusUpper = (veh.payment_status || 'UNPAID').toUpperCase();
    const isPaid = statusUpper === 'PAID';
    const isPartial = statusUpper === 'PARTIAL';

    if (isPaid) {
      lines.push('Payment status: ✅ Payment completed');
    } else if (isPartial) {
      lines.push('Payment status: ⏳ Payment partial');
    } else {
      lines.push('Payment status: ⏳ Payment pending');
    }

    // Show balance due if applicable
    const balance = veh.balance_due ?? 0;
    if (!isPaid && balance > 0) {
      lines.push('');
      lines.push(`Balance due: ₹${balance.toLocaleString('en-IN')}`);
    }

    // Include policy-document link only when valid URL exists
    if (veh.policy_document_url && veh.policy_document_url.trim()) {
      lines.push('');
      lines.push(`Policy document: ${veh.policy_document_url.trim()}`);
      hasDocumentLink = true;
    }

    // Include customer-facing payment link only when unpaid and valid URL exists
    if (!isPaid && veh.payment_url && veh.payment_url.trim()) {
      lines.push('');
      lines.push(`Payment link: ${veh.payment_url.trim()}`);
    }
  });

  // Append 5-minute document-link expiry warning if any policy document exists
  if (hasDocumentLink) {
    lines.push('');
    lines.push('⚠️ Policy document links expire in 5 minutes. Please download your document immediately.');
  }

  return lines.join('\n');
}

/**
 * Fetch customer renewal details from Application A (FastAPI).
 */
export async function fetchCustomerRenewals(phone: string): Promise<RenewalsApiResponse> {
  const baseUrl = process.env.FASTAPI_BASE_URL;
  if (!baseUrl) {
    throw new Error('FASTAPI_BASE_URL environment variable is not configured');
  }

  const serviceToken = process.env.FASTAPI_SERVICE_TOKEN;
  const url = `${baseUrl.replace(/\/+$/, '')}/api/v1/integrations/renewals-by-phone?phone=${encodeURIComponent(phone)}`;

  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (serviceToken) {
    headers['X-Service-Token'] = serviceToken;
    headers['Authorization'] = `Bearer ${serviceToken}`;
  }

  const response = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(8000), // 8-second timeout
  });

  if (!response.ok) {
    throw new Error(`FastAPI responded with HTTP ${response.status}`);
  }

  return (await response.json()) as RenewalsApiResponse;
}

export interface HandleRenewalsParams {
  db: SupabaseClient;
  accountId: string;
  conversationId: string;
  verifiedPhone: string;
}

/**
 * Handle the "Renewals on My Number" trigger:
 * 1. Queries FastAPI using the verified sender phone number
 * 2. Formats response text with vehicles, payment status, balance, and expiring document URLs
 * 3. Sends reply via Meta Cloud API and stores in conversation history
 */
export async function handleRenewalsTrigger(params: HandleRenewalsParams): Promise<boolean> {
  const { db, accountId, conversationId, verifiedPhone } = params;

  let replyText: string;
  try {
    const data = await fetchCustomerRenewals(verifiedPhone);
    replyText = formatRenewalsReply(data);
  } catch (err) {
    console.error('[RenewalsTrigger] Failed to fetch customer renewals from FastAPI:', err);
    // Safe fallback without exposing internal error messages or URLs
    replyText =
      'We are unable to retrieve your renewal details right now. Please try again in a few moments or reply here for assistance.';
  }

  try {
    await sendMessageToConversation(db, accountId, {
      conversationId,
      messageType: 'text',
      contentText: replyText,
    });
    return true;
  } catch (err) {
    console.error('[RenewalsTrigger] Failed to send renewals reply message:', err);
    return false;
  }
}

export interface WorkflowActionParams {
  db: SupabaseClient;
  accountId: string;
  conversationId: string;
}

/**
 * Send the menu or greeting response to the customer.
 */
export async function handleMenuOrGreeting(
  params: WorkflowActionParams & { isGreeting: boolean },
): Promise<boolean> {
  const { db, accountId, conversationId, isGreeting: isGreetingMode } = params;
  try {
    const activeWorkflows = await getActiveClientWorkflows(db, accountId);
    const interactivePayload = buildInteractiveMenuPayload(activeWorkflows);

    try {
      await sendMessageToConversation(db, accountId, {
        conversationId,
        messageType: 'interactive',
        interactivePayload,
      });
      return true;
    } catch (interactiveErr) {
      console.warn('[WorkflowDispatcher] Interactive list send failed, falling back to text:', interactiveErr);
      const text = formatMenuMessage(activeWorkflows, isGreetingMode);
      await sendMessageToConversation(db, accountId, {
        conversationId,
        messageType: 'text',
        contentText: text,
      });
      return true;
    }
  } catch (err) {
    console.error('[WorkflowDispatcher] Failed to send menu/greeting:', err);
    return false;
  }
}

/**
 * Send a helpful fallback response when message is unrecognized.
 */
export async function handleFallbackMessage(
  params: WorkflowActionParams,
): Promise<boolean> {
  const { db, accountId, conversationId } = params;
  try {
    const text = formatFallbackMessage();
    await sendMessageToConversation(db, accountId, {
      conversationId,
      messageType: 'text',
      contentText: text,
    });
    return true;
  } catch (err) {
    console.error('[WorkflowDispatcher] Failed to send fallback message:', err);
    return false;
  }
}
