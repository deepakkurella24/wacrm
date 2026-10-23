import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isRenewalsTrigger,
  formatRenewalsReply,
  fetchCustomerRenewals,
  handleRenewalsTrigger,
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
});
