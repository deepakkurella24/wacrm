import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isRenewalsTrigger,
  isGreeting,
  isMenuTrigger,
  formatRenewalsReply,
  formatMenuMessage,
  formatFallbackMessage,
  fetchCustomerRenewals,
  handleRenewalsTrigger,
  handleMenuOrGreeting,
  handleFallbackMessage,
  getActiveClientWorkflows,
  buildInteractiveMenuPayload,
  DEFAULT_RENEWALS_HEADER_MESSAGE,
  DEFAULT_UNRECOGNIZED_MESSAGE,
  type RenewalsApiResponse,
} from './renewals-service';
import * as sendMessageModule from '@/lib/whatsapp/send-message';

describe('Renewals Integration & Triggers', () => {
  describe('isRenewalsTrigger matcher', () => {
    it('matches configured trigger "My Policies" and singular "My Policy" case-insensitively', () => {
      expect(isRenewalsTrigger('My Policies')).toBe(true);
      expect(isRenewalsTrigger('my policies')).toBe(true);
      expect(isRenewalsTrigger('MY POLICIES')).toBe(true);
      expect(isRenewalsTrigger('My Policy')).toBe(true);
      expect(isRenewalsTrigger('my policy')).toBe(true);
      expect(isRenewalsTrigger('MY POLICY')).toBe(true);
    });

    it('matches legacy triggers "My Renewals" and singular "My Renewal" case-insensitively', () => {
      expect(isRenewalsTrigger('My Renewal')).toBe(true);
      expect(isRenewalsTrigger('my renewal')).toBe(true);
      expect(isRenewalsTrigger('MY RENEWAL')).toBe(true);
      expect(isRenewalsTrigger('My Renewals')).toBe(true);
      expect(isRenewalsTrigger('my renewals')).toBe(true);
      expect(isRenewalsTrigger('MY RENEWALS')).toBe(true);
    });

    it('matches variant "My Reenewals" and singular "My Reenewal" gracefully', () => {
      expect(isRenewalsTrigger('My Reenewal')).toBe(true);
      expect(isRenewalsTrigger('my reenewal')).toBe(true);
      expect(isRenewalsTrigger('My Reenewals')).toBe(true);
      expect(isRenewalsTrigger('my reenewals')).toBe(true);
      expect(isRenewalsTrigger('MY REENEWALS')).toBe(true);
    });

    it('matches numeric option prefix "1. My Policies", "1. My Policy", "1. My Renewal", "1. My Renewals", and "1"', () => {
      expect(isRenewalsTrigger('1. My Policies')).toBe(true);
      expect(isRenewalsTrigger('1. my policies')).toBe(true);
      expect(isRenewalsTrigger('1. My Policy')).toBe(true);
      expect(isRenewalsTrigger('1. my policy')).toBe(true);
      expect(isRenewalsTrigger('1. My Renewal')).toBe(true);
      expect(isRenewalsTrigger('1. my renewal')).toBe(true);
      expect(isRenewalsTrigger('1. My Renewals')).toBe(true);
      expect(isRenewalsTrigger('1. my renewals')).toBe(true);
      expect(isRenewalsTrigger('1. My Reenewals')).toBe(true);
      expect(isRenewalsTrigger('1. my reenewals')).toBe(true);
      expect(isRenewalsTrigger('1')).toBe(true);
    });

    it('matches with leading/trailing whitespace and multiple internal spaces', () => {
      expect(isRenewalsTrigger('   my   policies   ')).toBe(true);
      expect(isRenewalsTrigger('\nmy policies\t')).toBe(true);
      expect(isRenewalsTrigger('   my   renewals   ')).toBe(true);
      expect(isRenewalsTrigger('\nmy renewals\t')).toBe(true);
      expect(isRenewalsTrigger('   my   reenewals   ')).toBe(true);
    });

    it('matches with standard trailing and leading punctuation', () => {
      expect(isRenewalsTrigger('my policies.')).toBe(true);
      expect(isRenewalsTrigger('My Policies!')).toBe(true);
      expect(isRenewalsTrigger('"My Policies"')).toBe(true);
      expect(isRenewalsTrigger('my renewals.')).toBe(true);
      expect(isRenewalsTrigger('My Renewals!')).toBe(true);
      expect(isRenewalsTrigger('"My Renewals"')).toBe(true);
      expect(isRenewalsTrigger('my reenewals.')).toBe(true);
      expect(isRenewalsTrigger('My Reenewals!')).toBe(true);
      expect(isRenewalsTrigger('"My Reenewals"')).toBe(true);
    });

    it('rejects unrelated messages containing similar words', () => {
      expect(isRenewalsTrigger('What are my reenewals?')).toBe(false);
      expect(isRenewalsTrigger('my reenewals and my car')).toBe(false);
      expect(isRenewalsTrigger('What are my renewals?')).toBe(false);
      expect(isRenewalsTrigger('renewals')).toBe(false);
      expect(isRenewalsTrigger('my number')).toBe(false);
      expect(isRenewalsTrigger('Renewals on My Number')).toBe(false); // Old trigger rejected
      expect(isRenewalsTrigger('')).toBe(false);
      expect(isRenewalsTrigger(null)).toBe(false);
      expect(isRenewalsTrigger(undefined)).toBe(false);
    });
  });

  describe('formatRenewalsReply', () => {
    it('returns clean fallback when no customer or vehicles are found', () => {
      const response: RenewalsApiResponse = {
        found: false,
        vehicles: [],
      };
      const text = formatRenewalsReply(response);
      expect(text).toContain('No registered vehicles or policy renewals were found');
    });

    it('formats multiple vehicles matching user specification with Telugu header and statuses', () => {
      const response: RenewalsApiResponse = {
        found: true,
        customer_name: 'Test Customer',
        vehicles: [
          {
            registration_number: 'AP20BA1232',
            model: 'Honda City',
            policy_status: 'ACTIVE',
            policy_period_start: '10-07-2026',
            policy_period_end: '09-07-2027',
            policy_document_url: 'https://storage.example.com/doc1.pdf',
            payment_url: null,
            payment_status: 'PAID',
            balance_due: 0,
          },
          {
            registration_number: 'AP22BC1222',
            model: 'Hyundai Creta',
            policy_status: 'ACTIVE',
            policy_period_start: '10-11-2025',
            policy_period_end: '09-11-2026',
            policy_document_url: 'https://storage.example.com/doc2.pdf',
            renewal_status: 'RENEWAL_MODE',
            renewal_premium: 12500,
            payment_url: 'https://pay.insurer.com/creta123',
            payment_status: 'UNPAID',
            balance_due: 12500,
          },
          {
            registration_number: 'AP37BM2821',
            model: 'Hero Glamour',
            policy_status: 'EXPIRED',
            policy_period_start: '10-10-2025',
            policy_period_end: '09-10-2026',
            policy_document_url: 'https://storage.example.com/doc_prev.pdf',
            renewal_premium: 1196,
            payment_url: 'https://pay.insurer.com/glamour123',
            payment_status: 'UNPAID',
            balance_due: 1196,
          },
        ],
      };

      const reply = formatRenewalsReply(response);

      // Header
      expect(reply).toContain('మీ పాలసీల వివరాలు:');

      // Vehicle 1: Active with completed period and proof document
      expect(reply).toContain(
        '1. AP20BA1232 – Honda City\nPolicy status: Active ✅\nPolicy Period: 10-07-2026 to 09-07-2027\nPolicy document 📄: https://storage.example.com/doc1.pdf'
      );

      // Vehicle 2: Active in Renewal Mode with upcoming premium and link
      expect(reply).toContain(
        '2. AP22BC1222 – Hyundai Creta\nPolicy status: Active ✅\nPolicy Period: 10-11-2025 to 09-11-2026\nPolicy document 📄: https://storage.example.com/doc2.pdf\nRenewal status: Renewal Mode 🔁\nRenewal premium: ₹12,500\nPayment link: https://pay.insurer.com/creta123'
      );

      // Vehicle 3: Expired with previous document and pending renewal link
      expect(reply).toContain(
        '3. AP37BM2821 – Hero Glamour\nPolicy status: Expired 🚫\nPolicy Period: 10-10-2025 to 09-10-2026\nPolicy document 📄: https://storage.example.com/doc_prev.pdf\nRenewal premium: ₹1,196\nPayment link: https://pay.insurer.com/glamour123'
      );

      // 5-minute expiry warning appended because document link exists
      expect(reply).toContain('⚠️ డాక్యుమెంట్ లింక్ 5 నిమిషాల్లో ఎక్స్పైర్ అవుతుంది. వెంటనే డౌన్లోడ్ చేసుకోండి.');

      // Support contact footer
      expect(reply).toContain('ఇతర వివరములు మరియు సహాయం కొరకు ఈ క్రింది నెంబర్ల కి కాల్ చేయండి:');
      expect(reply).toContain('9640050096');
      expect(reply).toContain('9491675999');
      expect(reply).toContain('9908967599');
    });

    it('omits 5-minute expiry warning if no policy document exists', () => {
      const response: RenewalsApiResponse = {
        found: true,
        vehicles: [
          {
            registration_number: 'AP22BC1222',
            model: 'Model',
            payment_status: 'UNPAID',
            balance_due: 5000,
            policy_document_url: null,
            payment_url: 'https://pay.insurer.com/invoice123',
          },
        ],
      };

      const reply = formatRenewalsReply(response);
      expect(reply).not.toContain('5 నిమిషాల్లో');
    });

    it('formats a renewed policy as Active with renewed dates and document', () => {
      const response: RenewalsApiResponse = {
        found: true,
        vehicles: [
          {
            registration_number: 'AP22BC1222',
            model: 'Hyundai Creta',
            policy_status: 'ACTIVE',
            policy_period_start: '10-10-2026',
            policy_period_end: '09-10-2027',
            policy_document_url: 'https://storage.example.com/creta_renewed.pdf',
            renewal_status: null,
            renewal_premium: null,
            payment_url: null,
            payment_status: 'PAID',
            balance_due: 0,
          },
        ],
      };

      const reply = formatRenewalsReply(response);
      expect(reply).toContain('1. AP22BC1222 – Hyundai Creta');
      expect(reply).toContain('Policy status: Active ✅');
      expect(reply).toContain('Policy Period: 10-10-2026 to 09-10-2027');
      expect(reply).toContain('Policy document 📄: https://storage.example.com/creta_renewed.pdf');
      expect(reply).not.toContain('Payment link:');
      expect(reply).not.toContain('Renewal premium:');
    });
  });

  describe('fetchCustomerRenewals', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
      process.env.FASTAPI_BASE_URL = 'https://api.example.com';
      process.env.FASTAPI_SERVICE_TOKEN = 'test-secret-token';
    });

    afterEach(() => {
      process.env = originalEnv;
      vi.restoreAllMocks();
    });

    it('makes authenticated request to FastAPI with normalized phone', async () => {
      const mockData: RenewalsApiResponse = {
        found: true,
        vehicles: [],
      };

      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => mockData,
      } as Response);

      const result = await fetchCustomerRenewals('+91-98765-43210');
      expect(result.found).toBe(true);

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.example.com/api/v1/integrations/renewals-by-phone?phone=919876543210',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'X-Service-Token': 'test-secret-token',
          }),
        })
      );
    });

    it('throws when FastAPI returns error status', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as Response);

      await expect(fetchCustomerRenewals('9876543210')).rejects.toThrow('FastAPI responded with HTTP 500');
    });

    it('throws when request times out or network fails', async () => {
      vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('Network error'));
      await expect(fetchCustomerRenewals('9876543210')).rejects.toThrow('Failed to reach renewal service');
    });
  });

  describe('handleRenewalsTrigger', () => {
    const mockDb = {} as any;

    beforeEach(() => {
      process.env.FASTAPI_BASE_URL = 'https://api.example.com';
      process.env.FASTAPI_SERVICE_TOKEN = 'test-secret-token';
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('fetches renewals, formats message, and calls executeSendMessage', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          found: true,
          vehicles: [
            {
              registration_number: 'AP20BA1232',
              model: 'Honda City',
              payment_status: 'PAID',
              policy_document_url: 'https://doc.pdf',
            },
          ],
        }),
      } as Response);

      const executeSendSpy = vi
        .spyOn(sendMessageModule, 'sendMessageToConversation')
        .mockResolvedValueOnce({ messageId: 'm1', whatsappMessageId: 'wamid1' });

      const handled = await handleRenewalsTrigger({
        db: mockDb,
        accountId: 'acc-1',
        conversationId: 'conv-1',
        verifiedPhone: '9876543210',
      });

      expect(handled).toBe(true);
      expect(executeSendSpy).toHaveBeenCalledWith(
        mockDb,
        'acc-1',
        expect.objectContaining({
          conversationId: 'conv-1',
          messageType: 'text',
          contentText: expect.stringContaining('AP20BA1232 – Honda City'),
        })
      );
    });

    it('falls back safely without leaking internal errors when FastAPI fails', async () => {
      vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('Network connection refused'));

      const executeSendSpy = vi
        .spyOn(sendMessageModule, 'sendMessageToConversation')
        .mockResolvedValueOnce({ messageId: 'm1', whatsappMessageId: 'wamid1' });

      const handled = await handleRenewalsTrigger({
        db: mockDb,
        accountId: 'acc-1',
        conversationId: 'conv-1',
        verifiedPhone: '9876543210',
      });

      expect(handled).toBe(true);
      expect(executeSendSpy).toHaveBeenCalledWith(
        mockDb,
        'acc-1',
        expect.objectContaining({
          contentText: expect.stringContaining('We are unable to retrieve your renewal details right now'),
        })
      );
    });
  });

  describe('isGreeting matcher', () => {
    it('matches common greeting words case-insensitively', () => {
      expect(isGreeting('hi')).toBe(true);
      expect(isGreeting('HI')).toBe(true);
      expect(isGreeting('hello')).toBe(true);
      expect(isGreeting('Hello')).toBe(true);
      expect(isGreeting('hlo')).toBe(true);
      expect(isGreeting('hey')).toBe(true);
      expect(isGreeting('namaste')).toBe(true);
      expect(isGreeting('good morning')).toBe(true);
      expect(isGreeting('good afternoon')).toBe(true);
      expect(isGreeting('good evening')).toBe(true);
    });

    it('matches with leading/trailing whitespace and punctuation', () => {
      expect(isGreeting('  hello! ')).toBe(true);
      expect(isGreeting('Hi.')).toBe(true);
      expect(isGreeting(' hey! ')).toBe(true);
      expect(isGreeting('\ngood morning\t')).toBe(true);
    });

    it('rejects non-greeting messages', () => {
      expect(isGreeting('hello, I want to cancel my policy')).toBe(false);
      expect(isGreeting('hi there my friend')).toBe(false);
      expect(isGreeting('renewals')).toBe(false);
      expect(isGreeting('')).toBe(false);
      expect(isGreeting(null)).toBe(false);
      expect(isGreeting(undefined)).toBe(false);
    });
  });

  describe('isMenuTrigger matcher', () => {
    it('matches menu keywords case-insensitively', () => {
      expect(isMenuTrigger('menu')).toBe(true);
      expect(isMenuTrigger('MENU')).toBe(true);
      expect(isMenuTrigger('options')).toBe(true);
      expect(isMenuTrigger('OPTIONS')).toBe(true);
      expect(isMenuTrigger('help')).toBe(true);
      expect(isMenuTrigger('HELP')).toBe(true);
    });

    it('matches with whitespace and punctuation', () => {
      expect(isMenuTrigger('  menu  ')).toBe(true);
      expect(isMenuTrigger('menu!')).toBe(true);
      expect(isMenuTrigger('options.')).toBe(true);
    });

    it('rejects unrelated text containing menu words', () => {
      expect(isMenuTrigger('show me the menu please')).toBe(false);
      expect(isMenuTrigger('need help with payment')).toBe(false);
      expect(isMenuTrigger('')).toBe(false);
      expect(isMenuTrigger(null)).toBe(false);
      expect(isMenuTrigger(undefined)).toBe(false);
    });
  });

  describe('formatMenuMessage', () => {
    const mockWorkflows = [
      { id: 'wf-1', name: 'File a Claim', keywords: ['claim'] },
      { id: 'wf-2', name: 'Branch Locations', keywords: ['branch', 'office'] },
    ];

    it('formats menu in standard mode with configured trigger', () => {
      const menu = formatMenuMessage(mockWorkflows, false);
      expect(menu).not.toContain('Hello! Welcome');
      expect(menu).toContain('Available Services:');
      expect(menu).toContain('1. My Policies');
      expect(menu).toContain('2. File a Claim');
      expect(menu).toContain('3. Branch Locations');
      expect(menu).toContain('Reply with any option above, or send MENU at any time');
    });

    it('formats menu in greeting mode with welcome banner', () => {
      const menu = formatMenuMessage(mockWorkflows, true);
      expect(menu).toContain('Hello! Welcome to our insurance service');
      expect(menu).toContain('Available Services:');
      expect(menu).toContain('1. My Policies');
      expect(menu).toContain('2. File a Claim');
      expect(menu).toContain('3. Branch Locations');
    });

    it('deduplicates My Policies if client flow shares the same name', () => {
      const wfsWithDuplicate = [
        { id: 'wf-0', name: 'My Policies', keywords: ['policies'] },
        { id: 'wf-1', name: 'File a Claim', keywords: ['claim'] },
      ];
      const menu = formatMenuMessage(wfsWithDuplicate, false);
      const count = (menu.match(/My Policies/g) || []).length;
      expect(count).toBe(1);
      expect(menu).toContain('1. My Policies');
      expect(menu).toContain('2. File a Claim');
    });
  });

  describe('formatFallbackMessage', () => {
    it('returns helpful Telugu instructions with menu guidance', () => {
      const fallback = formatFallbackMessage();
      expect(fallback).toContain('మీ మెసేజ్ వచ్చింది, కానీ అర్థం కాలేదు.');
      expect(fallback).toContain('కింద ఉన్న లిస్ట్ లో నుండి ఒక ఆప్షన్ సెలెక్ట్ చేయండి 👇');
    });
  });

  describe('getActiveClientWorkflows', () => {
    it('queries only active flows from database', async () => {
      const mockQueryChain: any = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockImplementation((col: string, val: string) => {
          if (col === 'account_id') {
            return {
              eq: vi.fn((statusCol: string, statusVal: string) => {
                expect(statusCol).toBe('status');
                expect(statusVal).toBe('active');
                return {
                  order: vi.fn().mockResolvedValue({
                    data: [
                      {
                        id: 'flow-1',
                        name: 'Policy FAQs',
                        trigger_type: 'keyword',
                        trigger_config: { keywords: ['faq'] },
                        status: 'active',
                      },
                    ],
                    error: null,
                  }),
                };
              }),
            };
          }
          return mockQueryChain;
        }),
      };
      const db: any = { from: () => mockQueryChain };

      const workflows = await getActiveClientWorkflows(db, 'acc-1');
      expect(workflows).toHaveLength(1);
      expect(workflows[0].name).toBe('Policy FAQs');
      expect(workflows[0].keywords).toEqual(['faq']);
    });
  });

  describe('buildInteractiveMenuPayload', () => {
    it('creates interactive list payload with configured My Policies title and NO row descriptions', () => {
      const activeWorkflows = [
        {
          id: 'wf-1',
          name: 'Contact Support',
          keywords: ['support', 'help'],
        },
      ];
      const payload = buildInteractiveMenuPayload(activeWorkflows);
      expect(payload.kind).toBe('list');
      expect(payload.button_label).toBe('Menu');
      expect(payload.sections).toHaveLength(1);

      const section = payload.sections[0];
      expect(section.title).toBe('Our Services');
      expect(section.rows).toHaveLength(2);
      expect(section.rows[0].title).toBe('My Policies');

      // Verify NO row contains a description field
      section.rows.forEach((row) => {
        expect(row).toHaveProperty('id');
        expect(row).toHaveProperty('title');
        expect(row).not.toHaveProperty('description');
      });
    });
  });

  describe('handleMenuOrGreeting & handleFallbackMessage actions', () => {
    it('handleMenuOrGreeting queries active flows and sends formatted menu', async () => {
      const executeSendSpy = vi
        .spyOn(sendMessageModule, 'sendMessageToConversation')
        .mockResolvedValueOnce({ messageId: 'm1', whatsappMessageId: 'wamid1' });

      const mockQueryChain: any = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockImplementation(() => ({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({
              data: [
                {
                  id: 'wf-1',
                  name: 'Live Agent',
                  trigger_type: 'keyword',
                  trigger_config: { keywords: ['agent'] },
                  status: 'active',
                },
              ],
              error: null,
            }),
          }),
        })),
      };
      const db: any = { from: () => mockQueryChain };

      const handled = await handleMenuOrGreeting({
        db,
        accountId: 'acc-1',
        conversationId: 'conv-1',
        isGreeting: true,
      });

      expect(handled).toBe(true);
      expect(executeSendSpy).toHaveBeenCalledWith(
        db,
        'acc-1',
        expect.objectContaining({
          conversationId: 'conv-1',
          messageType: 'interactive',
          interactivePayload: expect.objectContaining({
            kind: 'list',
            button_label: 'Menu',
            body: expect.stringContaining('PULI Insurance Services'),
            sections: expect.arrayContaining([
              expect.objectContaining({
                title: 'Our Services',
                rows: expect.arrayContaining([
                  expect.objectContaining({
                    id: 'renewals_on_my_number',
                    title: 'My Policies',
                  }),
                  expect.objectContaining({
                    title: 'Live Agent',
                  }),
                ]),
              }),
            ]),
          }),
        }),
      );
    });

    it('handleFallbackMessage sends interactive menu list with Telugu prompt', async () => {
      const executeSendSpy = vi
        .spyOn(sendMessageModule, 'sendMessageToConversation')
        .mockResolvedValueOnce({ messageId: 'm2', whatsappMessageId: 'wamid2' });

      const db: any = {};
      const handled = await handleFallbackMessage({
        db,
        accountId: 'acc-1',
        conversationId: 'conv-1',
      });

      expect(handled).toBe(true);
      expect(executeSendSpy).toHaveBeenCalledWith(
        db,
        'acc-1',
        expect.objectContaining({
          conversationId: 'conv-1',
          messageType: 'interactive',
          interactivePayload: expect.objectContaining({
            kind: 'list',
            button_label: 'Menu',
            body: expect.stringContaining('మీ మెసేజ్ వచ్చింది'),
          }),
        }),
      );
    });

    it('handleFallbackMessage falls back to text menu if interactive list fails', async () => {
      const executeSendSpy = vi
        .spyOn(sendMessageModule, 'sendMessageToConversation')
        .mockRejectedValueOnce(new Error('Interactive list rejected'))
        .mockResolvedValueOnce({ messageId: 'm3', whatsappMessageId: 'wamid3' });

      const db: any = {};
      const handled = await handleFallbackMessage({
        db,
        accountId: 'acc-1',
        conversationId: 'conv-1',
      });

      expect(handled).toBe(true);
      expect(executeSendSpy).toHaveBeenCalledWith(
        db,
        'acc-1',
        expect.objectContaining({
          conversationId: 'conv-1',
          messageType: 'text',
          contentText: expect.stringContaining('మీ మెసేజ్ వచ్చింది'),
        }),
      );
    });
  });
});
