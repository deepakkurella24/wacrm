import type { NeonDatabaseClient } from '@/lib/db/neon-client';
import { sendMessageToConversation } from '@/lib/whatsapp/send-message';
import type { InteractiveListPayload } from '@/lib/whatsapp/interactive';

export interface VehicleRenewalItem {
  registration_number: string;
  model?: string | null;
  policy_status?: 'ACTIVE' | 'EXPIRED' | 'NO_POLICY' | 'NO_RENEWAL' | string | null;
  policy_period_start?: string | null;
  policy_period_end?: string | null;
  policy_document_url?: string | null;
  renewal_status?: 'RENEWAL_MODE' | string | null;
  renewal_premium?: number | null;
  payment_url?: string | null;
  payment_status?: 'PAID' | 'PARTIAL' | 'UNPAID' | 'NO_RENEWAL' | string;
  balance_due?: number | null;
  gross_premium?: number | null;
  amount_paid?: number | null;
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
 * Match the configured policy & renewal trigger: "My Policies" (also matches "1. My Policies", "My Policy",
 * "1. My Policy", "1", and legacy triggers "My Renewals", "My Renewal").
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
    cleaned === 'my policies' ||
    cleaned === '1. my policies' ||
    cleaned === 'my policy' ||
    cleaned === '1. my policy' ||
    cleaned === 'my renewal' ||
    cleaned === '1. my renewal' ||
    cleaned === 'my renewals' ||
    cleaned === '1. my renewals' ||
    cleaned === 'my reenewal' ||
    cleaned === '1. my reenewal' ||
    cleaned === 'my reenewals' ||
    cleaned === '1. my reenewals' ||
    cleaned === '1'
  );
}

/**
 * Common greetings: hi, hello, hlo, hey, namaste, good morning, etc.
 */
const GREETINGS = new Set([
  'hii',
  'hiii',
  'hiiii',
  'hiiiii',
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
  db: NeonDatabaseClient | any,
  accountId: string,
): Promise<ActiveWorkflowItem[]> {
  if (!db || typeof db.from !== 'function') return [];
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
 * - Always includes Option 1: "My Policies".
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
  lines.push('1. My Policies');

  let index = 2;
  activeWorkflows.forEach((wf) => {
    const lower = wf.name.toLowerCase();
    if (
      lower === 'my policies' ||
      lower === 'my policy' ||
      lower === 'my reenewals' ||
      lower === 'my renewals' ||
      lower === 'my renewal' ||
      lower === 'renewals on my number'
    ) {
      return;
    }
    const label = wf.name || (wf.keywords.length > 0 ? wf.keywords[0] : `Service ${index}`);
    lines.push(`${index}. ${label}`);
    index += 1;
  });

  lines.push('');
  lines.push('Reply with any option above, or send MENU at any time to view this list.');

  return lines.join('\n');
}

export const DEFAULT_UNRECOGNIZED_MESSAGE =
  'మీ మెసేజ్ వచ్చింది, కానీ అర్థం కాలేదు.\nకింద ఉన్న లిస్ట్ లో నుండి ఒక ఆప్షన్ సెలెక్ట్ చేయండి 👇';

export const DEFAULT_WELCOME_MENU_MESSAGE =
  'హలో 👋,\nPULI Insurance Services కి స్వాగతం\n\nమీకు ఏ సర్వీస్ కావాలో కింద ఉన్న లిస్ట్ లో నుండి ఒకటి ఎంచుకోండి 👇';

export const DEFAULT_RENEWALS_HEADER_MESSAGE = 'మీ పాలసీల వివరాలు:';
export const DEFAULT_SUPPORT_HEADER_MESSAGE =
  'ఇతర వివరములు మరియు సహాయం కొరకు ఈ క్రింది నెంబర్ల కి కాల్ చేయండి:';
export const DEFAULT_SUPPORT_PHONE_NUMBERS = '9640050096\n9491675999\n9908967599';
export const DEFAULT_DOC_EXPIRY_WARNING =
  '⚠️ డాక్యుమెంట్ లింక్ 5 నిమిషాల్లో ఎక్స్పైర్ అవుతుంది. వెంటనే డౌన్లోడ్ చేసుకోండి.';

/**
 * Helper to fetch customizable bot message templates from the database.
 */
export async function getBotTemplateText(
  db: NeonDatabaseClient | any,
  key: string,
  fallbackText: string,
): Promise<string> {
  try {
    if (!db || typeof db.from !== 'function') return fallbackText;
    const { data, error } = await db
      .from('bot_message_templates')
      .select('message_text')
      .eq('key', key)
      .maybeSingle();
    if (!error && data?.message_text) {
      return data.message_text;
    }
  } catch {
    // Graceful fallback to default message text
  }
  return fallbackText;
}

/**
 * Build the interactive list menu payload for WhatsApp.
 * Header / body greeting users with PULI Insurance Services branding
 * and listing all active service workflows.
 */
export function buildInteractiveMenuPayload(
  activeWorkflows: ActiveWorkflowItem[] = [],
  customBody?: string,
): InteractiveListPayload {
  const rows: Array<{ id: string; title: string }> = [
    {
      id: 'renewals_on_my_number',
      title: 'My Policies',
    },
  ];

  activeWorkflows.forEach((wf) => {
    const lower = wf.name.toLowerCase();
    if (
      lower === 'my policies' ||
      lower === 'my policy' ||
      lower === 'my reenewals' ||
      lower === 'my renewals' ||
      lower === 'my renewal' ||
      lower === 'renewals on my number' ||
      lower === 'welcome menu'
    ) {
      return;
    }
    const title = wf.name.slice(0, 24);
    const id = wf.keywords.length > 0 ? wf.keywords[0].slice(0, 200) : wf.id;
    rows.push({ id, title });
  });

  return {
    kind: 'list',
    body: customBody || DEFAULT_WELCOME_MENU_MESSAGE,
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
  return DEFAULT_UNRECOGNIZED_MESSAGE;
}

/**
 * Format a human-readable WhatsApp text message from the FastAPI renewals response.
 * Follows exact specifications:
 * - Numbered vehicle list
 * - Policy status: Active ✅ / Expired 🚫
 * - Policy Period: DD-MM-YYYY to DD-MM-YYYY
 * - Policy document 📄: presigned 5-min link
 * - Renewal status: Renewal Mode 🔁
 * - Renewal premium: ₹X,XXX
 * - Payment link: customer-facing payment URL
 * - Appends 5-minute expiry notice ONLY if at least one document link exists
 * - Appends configurable Telugu support header and numbers
 */
export function formatRenewalsReply(
  data: RenewalsApiResponse,
  headerText: string = DEFAULT_RENEWALS_HEADER_MESSAGE,
  supportHeader: string = DEFAULT_SUPPORT_HEADER_MESSAGE,
  supportNumbers: string = DEFAULT_SUPPORT_PHONE_NUMBERS,
): string {
  if (!data.found || !data.vehicles || data.vehicles.length === 0) {
    return 'No registered vehicles or policy renewals were found for your phone number. If you believe this is an error, please reply here with your vehicle registration number.';
  }

  const lines: string[] = [headerText];
  let hasDocumentLink = false;

  data.vehicles.forEach((veh, index) => {
    lines.push(''); // Blank line separator before each vehicle
    const num = index + 1;
    const regNo = (veh.registration_number || 'UNKNOWN').trim();
    const model = (veh.model || '').trim();
    const header = model && model.toLowerCase() !== 'model' ? `${num}. ${regNo} – ${model}` : `${num}. ${regNo} – Model`;
    lines.push(header);

    // Policy status line
    const statusUpper = (veh.policy_status || (veh.payment_status === 'PAID' ? 'ACTIVE' : 'EXPIRED')).toUpperCase();
    if (statusUpper === 'ACTIVE') {
      lines.push('Policy status: Active ✅');
    } else if (statusUpper === 'EXPIRED') {
      lines.push('Policy status: Expired 🚫');
    } else {
      lines.push(`Policy status: ${veh.policy_status}`);
    }

    // Policy Period line
    if (veh.policy_period_start && veh.policy_period_end) {
      lines.push(`Policy Period: ${veh.policy_period_start} to ${veh.policy_period_end}`);
    }

    // Policy document line
    if (veh.policy_document_url && veh.policy_document_url.trim()) {
      lines.push(`Policy document 📄: ${veh.policy_document_url.trim()}`);
      hasDocumentLink = true;
    }

    // Renewal status line (e.g. Renewal Mode 🔁)
    if (veh.renewal_status === 'RENEWAL_MODE') {
      lines.push('Renewal status: Renewal Mode 🔁');
    }

    // Renewal premium line
    const premium = veh.renewal_premium ?? (veh.balance_due && veh.balance_due > 0 ? veh.balance_due : null);
    if (typeof premium === 'number' && premium > 0) {
      lines.push(`Renewal premium: ₹${premium.toLocaleString('en-IN')}`);
    }

    // Payment link line
    if (veh.payment_url && veh.payment_url.trim()) {
      lines.push(`Payment link: ${veh.payment_url.trim()}`);
    }
  });

  // Append 5-minute document-link expiry warning if any policy document exists
  if (hasDocumentLink) {
    lines.push('');
    lines.push(DEFAULT_DOC_EXPIRY_WARNING);
  }

  // Append support call header and configurable numbers
  if (supportHeader && supportNumbers) {
    lines.push('');
    lines.push(supportHeader);
    lines.push('');
    lines.push(supportNumbers);
  }

  return lines.join('\n');
}

/**
 * Fetch customer renewal details from Application A (FastAPI).
 * Validates responses, handles timeouts, network failures, and malformed data safely.
 */
export async function fetchCustomerRenewals(phone: string): Promise<RenewalsApiResponse> {
  const baseUrl = process.env.FASTAPI_BASE_URL;
  if (!baseUrl) {
    throw new Error('FASTAPI_BASE_URL environment variable is not configured');
  }

  // Normalize phone number to digits only
  const cleanPhone = phone.replace(/\D/g, '');
  if (!cleanPhone) {
    throw new Error('Invalid phone number provided for renewal lookup');
  }

  const serviceToken = process.env.FASTAPI_SERVICE_TOKEN;
  const url = `${baseUrl.replace(/\/+$/, '')}/api/v1/integrations/renewals-by-phone?phone=${encodeURIComponent(cleanPhone)}`;

  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (serviceToken) {
    headers['X-Service-Token'] = serviceToken;
    headers['Authorization'] = `Bearer ${serviceToken}`;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(8000), // 8-second timeout
    });
  } catch (err: unknown) {
    const isTimeout = err instanceof Error && err.name === 'TimeoutError';
    throw new Error(isTimeout ? 'Renewal service request timed out' : 'Failed to reach renewal service');
  }

  if (!response.ok) {
    throw new Error(`FastAPI responded with HTTP ${response.status}`);
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error('Malformed JSON received from renewal service');
  }

  if (!data || typeof data !== 'object') {
    throw new Error('Invalid response structure received from renewal service');
  }

  const res = data as Partial<RenewalsApiResponse>;
  const vehicles: VehicleRenewalItem[] = Array.isArray(res.vehicles)
    ? res.vehicles.map((v: any) => ({
        registration_number: String(v?.registration_number ?? 'UNKNOWN'),
        model: v?.model ? String(v.model) : null,
        policy_status: v?.policy_status ? String(v.policy_status) : null,
        policy_period_start: v?.policy_period_start ? String(v.policy_period_start) : null,
        policy_period_end: v?.policy_period_end ? String(v.policy_period_end) : null,
        renewal_status: v?.renewal_status ? String(v.renewal_status) : null,
        renewal_premium:
          typeof v?.renewal_premium === 'number'
            ? v.renewal_premium
            : v?.renewal_premium
            ? Number(v.renewal_premium)
            : null,
        payment_status: String(v?.payment_status ?? 'UNPAID'),
        balance_due:
          typeof v?.balance_due === 'number'
            ? v.balance_due
            : v?.balance_due
            ? Number(v.balance_due)
            : 0,
        gross_premium:
          typeof v?.gross_premium === 'number' ? v.gross_premium : null,
        amount_paid:
          typeof v?.amount_paid === 'number' ? v.amount_paid : null,
        policy_document_url:
          typeof v?.policy_document_url === 'string' &&
          v.policy_document_url.trim()
            ? v.policy_document_url.trim()
            : null,
        payment_url:
          typeof v?.payment_url === 'string' && v.payment_url.trim()
            ? v.payment_url.trim()
            : null,
      }))
    : [];

  return {
    found: Boolean(res.found),
    customer_name: res.customer_name ? String(res.customer_name) : null,
    phone: res.phone ? String(res.phone) : cleanPhone,
    message: res.message ? String(res.message) : null,
    vehicles,
  };
}

export interface HandleRenewalsParams {
  db: NeonDatabaseClient | any;
  accountId: string;
  conversationId: string;
  verifiedPhone: string;
}

/**
 * Handle the "My Renewals" trigger:
 * 1. Queries FastAPI using the verified sender phone number
 * 2. Formats response text with vehicles, payment status, balance, and expiring document URLs
 * 3. Sends reply via Meta Cloud API and stores in conversation history
 */
export async function handleRenewalsTrigger(params: HandleRenewalsParams): Promise<boolean> {
  const { db, accountId, conversationId, verifiedPhone } = params;

  let replyText: string;
  try {
    const data = await fetchCustomerRenewals(verifiedPhone);
    const headerText = await getBotTemplateText(
      db,
      'renewals_on_my_number',
      DEFAULT_RENEWALS_HEADER_MESSAGE,
    );
    const supportHeader = await getBotTemplateText(
      db,
      'renewals_support_header',
      DEFAULT_SUPPORT_HEADER_MESSAGE,
    );
    const supportNumbers = await getBotTemplateText(
      db,
      'renewals_support_numbers',
      process.env.SUPPORT_PHONE_NUMBERS || DEFAULT_SUPPORT_PHONE_NUMBERS,
    );
    replyText = formatRenewalsReply(data, headerText, supportHeader, supportNumbers);
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
  db: NeonDatabaseClient | any;
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
    const welcomeBody = await getBotTemplateText(
      db,
      'welcome_menu',
      DEFAULT_WELCOME_MENU_MESSAGE,
    );

    const activeWorkflows = await getActiveClientWorkflows(db, accountId);
    const interactivePayload = buildInteractiveMenuPayload(activeWorkflows, welcomeBody);

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
 * Send a helpful fallback response when message is unrecognized:
 * Sends the interactive Menu list with the Telugu unrecognized message prompt as the body,
 * allowing customers to select any service immediately.
 */
export async function handleFallbackMessage(
  params: WorkflowActionParams,
): Promise<boolean> {
  const { db, accountId, conversationId } = params;
  try {
    const templateText = await getBotTemplateText(
      db,
      'unrecognized_message',
      DEFAULT_UNRECOGNIZED_MESSAGE,
    );

    const activeWorkflows = await getActiveClientWorkflows(db, accountId);
    const interactivePayload = buildInteractiveMenuPayload(activeWorkflows, templateText);

    try {
      await sendMessageToConversation(db, accountId, {
        conversationId,
        messageType: 'interactive',
        interactivePayload,
      });
      return true;
    } catch (interactiveErr) {
      console.warn('[WorkflowDispatcher] Interactive list send failed for fallback, falling back to text:', interactiveErr);
      const menuList = formatMenuMessage(activeWorkflows, false);
      const text = `${templateText}\n\n${menuList}`;
      await sendMessageToConversation(db, accountId, {
        conversationId,
        messageType: 'text',
        contentText: text,
      });
      return true;
    }
  } catch (err) {
    console.error('[WorkflowDispatcher] Failed to send fallback message:', err);
    return false;
  }
}
