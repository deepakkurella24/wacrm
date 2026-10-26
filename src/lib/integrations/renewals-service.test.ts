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
  type RenewalsApiResponse,
} from './renewals-service';
import * as sendMessageModule from '@/lib/whatsapp/send-message';

describe('Renewals on My Number Trigger', () => {
  describe('isRenewalsTrigger matcher', () => {
    it('matches exact trigger text case-insensitively', () => {
      expect(isRenewalsTrigger('Renewals on My Number')).toBe(true);
      expect(isRenewalsTrigger('renewals on my number')).toBe(true);
      expect(isRenewalsTrigger('RENEWALS ON MY NUMBER')).toBe(true);
    });

    it('matches with leading/trailing whitespace and multiple internal spaces', () => {
      expect(isRenewalsTrigger('   renewals   on   my   number   ')).toBe(true);
      expect(isRenewalsTrigger('\nrenewals on my number\t')).toBe(true);
    });

    it('matches with standard trailing punctuation', () => {
      expect(isRenewalsTrigger('renewals on my number.')).toBe(true);
      expect(isRenewalsTrigger('Renewals on My Number!')).toBe(true);
      expect(isRenewalsTrigger('"Renewals on My Number"')).toBe(true);
    });

    it('rejects unrelated messages containing similar words', () => {
      expect(isRenewalsTrigger('What are renewals on my number?')).toBe(false);
      expect(isRenewalsTrigger('renewals on my number and my car')).toBe(false);
      expect(isRenewalsTrigger('renewals')).toBe(false);
      expect(isRenewalsTrigger('my number')).toBe(false);
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

    it('formats multiple vehicles matching user specification', () => {
      const response: RenewalsApiResponse = {
        found: true,
        customer_name: 'Test Customer',
        vehicles: [
          {
            registration_number: 'AP20BA1232',
            model: 'Model',
            payment_status: 'PAID',
            balance_due: 0,
            policy_document_url: 'https://storage.example.com/doc1.pdf',
            payment_url: null,
          },
          {
            registration_number: 'AP22BC1222',
            model: 'Model',
            payment_status: 'UNPAID',
            balance_due: 12500,
            policy_document_url: null,
            payment_url: 'https://pay.insurer.com/invoice123',
          },
        ],
      };

      const reply = formatRenewalsReply(response);

      // Header
      expect(reply).toContain('Your Vehicle Renewal Details');

      // Vehicle 1: Completed payment with policy document
      expect(reply).toContain('1. AP20BA1232 – Model');
      expect(reply).toContain('Payment status: ✅ Payment completed');
      expect(reply).toContain('Policy document: https://storage.example.com/doc1.pdf');
      expect(reply).not.toContain('Balance due: ₹0');

      // Vehicle 2: Pending payment with balance and customer payment link
      expect(reply).toContain('2. AP22BC1222 – Model');
      expect(reply).toContain('Payment status: ⏳ Payment pending');
      expect(reply).toContain('Balance due: ₹12,500');
      expect(reply).toContain('Payment link: https://pay.insurer.com/invoice123');

      // 5-minute expiry warning appended because vehicle 1 has a document link
      expect(reply).toContain('⚠️ Policy document links expire in 5 minutes. Please download your document immediately.');
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
      expect(reply).not.toContain('Policy document links expire in 5 minutes');
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

      const result = await fetchCustomerRenewals('919876543210');
      expect(result).toEqual(mockData);

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

    it('formats menu in standard mode', () => {
      const menu = formatMenuMessage(mockWorkflows, false);
      expect(menu).not.toContain('Hello! Welcome');
      expect(menu).toContain('Available Services:');
      expect(menu).toContain('1. Renewals on My Number');
      expect(menu).toContain('2. File a Claim');
      expect(menu).toContain('3. Branch Locations');
      expect(menu).toContain('Reply with any option above, or send MENU at any time');
    });

    it('formats menu in greeting mode with welcome banner', () => {
      const menu = formatMenuMessage(mockWorkflows, true);
      expect(menu).toContain('Hello! Welcome to our insurance service');
      expect(menu).toContain('Available Services:');
      expect(menu).toContain('1. Renewals on My Number');
      expect(menu).toContain('2. File a Claim');
      expect(menu).toContain('3. Branch Locations');
    });

    it('deduplicates Renewals on My Number if client flow shares the same name', () => {
      const wfsWithDuplicate = [
        { id: 'wf-0', name: 'Renewals on My Number', keywords: ['renewals'] },
        { id: 'wf-1', name: 'File a Claim', keywords: ['claim'] },
      ];
      const menu = formatMenuMessage(wfsWithDuplicate, false);
      const count = (menu.match(/Renewals on My Number/g) || []).length;
      expect(count).toBe(1);
      expect(menu).toContain('1. Renewals on My Number');
      expect(menu).toContain('2. File a Claim');
    });
  });

  describe('formatFallbackMessage', () => {
    it('returns helpful instructions referencing MENU and Renewals on My Number', () => {
      const fallback = formatFallbackMessage();
      expect(fallback).toContain("couldn't recognize your request");
      expect(fallback).toContain('*MENU*');
      expect(fallback).toContain('*Renewals on My Number*');
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
                    title: 'Renewals on My Number',
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

    it('handleFallbackMessage sends standard unrecognized message fallback', async () => {
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
          contentText: expect.stringContaining("couldn't recognize your request"),
        }),
      );
    });
  });
});

