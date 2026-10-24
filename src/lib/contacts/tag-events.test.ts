import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
}));

vi.mock('./tag-write', () => ({
  addContactTagIfAbsent: mocks.add,
}));

import {
  addContactTagAndDispatch,
  getTagChainDepth,
  MAX_TAG_CHAIN_DEPTH,
} from './tag-events';

const base = {
  db: {} as never,
  accountId: 'account-1',
  contactId: 'contact-1',
  tagId: 'tag-1',
};

beforeEach(() => {
  mocks.add.mockReset();
});

describe('addContactTagAndDispatch', () => {
  it('adds tag when absent', async () => {
    mocks.add.mockResolvedValue(true);

    const result = await addContactTagAndDispatch({
      ...base,
    });

    expect(result).toEqual({ added: true, dispatched: false });
  });

  it('does not dispatch when the tag already exists', async () => {
    mocks.add.mockResolvedValue(false);

    await expect(addContactTagAndDispatch(base)).resolves.toEqual({
      added: false,
      dispatched: false,
      reason: 'duplicate',
    });
  });
});

describe('getTagChainDepth', () => {
  it('extracts depth or defaults to zero', () => {
    expect(getTagChainDepth(undefined)).toBe(0);
    expect(getTagChainDepth({ vars: { _tag_chain_depth: 2 } })).toBe(2);
  });
});
