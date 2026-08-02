import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Module will be created in GREEN phase
import {
  syncContact,
  addContactToList,
  removeContactFromList,
  addTagToContact,
  resolveListId,
  resolveTagId,
  addContactToEmailList,
  tagBuyer,
  _resetCache,
} from '../client';

const AC_URL = 'https://test.api-us1.com';
const AC_KEY = 'test-api-key-123';

function mockFetchResponse(data: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  });
}

describe('AC client — low-level functions', () => {
  beforeEach(() => {
    vi.stubEnv('ACTIVECAMPAIGN_API_URL', AC_URL);
    vi.stubEnv('ACTIVECAMPAIGN_API_KEY', AC_KEY);
    _resetCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe('syncContact', () => {
    it('POST /contact/sync with email and returns numeric contact ID', async () => {
      const mockFetch = mockFetchResponse({ contact: { id: '42' } });
      vi.stubGlobal('fetch', mockFetch);

      const id = await syncContact('user@test.com');

      expect(id).toBe(42);
      expect(mockFetch).toHaveBeenCalledOnce();

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(`${AC_URL}/api/3/contact/sync`);
      expect(opts.method).toBe('POST');
      expect(opts.headers['Api-Token']).toBe(AC_KEY);
      expect(opts.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(opts.body)).toEqual({ contact: { email: 'user@test.com' } });
    });

    it('throws on non-200 response with status and body', async () => {
      const mockFetch = mockFetchResponse({ message: 'error' }, false, 422);
      vi.stubGlobal('fetch', mockFetch);

      await expect(syncContact('bad@test.com')).rejects.toThrow('422');
    });

    it('uses AbortSignal.timeout(15000)', async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
      const mockFetch = mockFetchResponse({ contact: { id: '1' } });
      vi.stubGlobal('fetch', mockFetch);

      await syncContact('user@test.com');

      // acFetch uses AC_TIMEOUT_MS = 15_000 (15s per request).
      expect(timeoutSpy).toHaveBeenCalledWith(15_000);
    });
  });

  describe('addContactToList', () => {
    it('POST /contactLists with status:1 (subscribe)', async () => {
      const mockFetch = mockFetchResponse({ contactList: {} });
      vi.stubGlobal('fetch', mockFetch);

      await addContactToList(123, 456);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(`${AC_URL}/api/3/contactLists`);
      expect(JSON.parse(opts.body)).toEqual({
        contactList: { list: 456, contact: 123, status: 1 },
      });
    });
  });

  describe('removeContactFromList', () => {
    it('POST /contactLists with status:2 (unsubscribe)', async () => {
      const mockFetch = mockFetchResponse({ contactList: {} });
      vi.stubGlobal('fetch', mockFetch);

      await removeContactFromList(123, 456);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(`${AC_URL}/api/3/contactLists`);
      expect(JSON.parse(opts.body)).toEqual({
        contactList: { list: 456, contact: 123, status: 2 },
      });
    });
  });

  describe('addTagToContact', () => {
    it('POST /contactTags with string values (Pitfall 3)', async () => {
      const mockFetch = mockFetchResponse({ contactTag: {} });
      vi.stubGlobal('fetch', mockFetch);

      await addTagToContact(123, 20);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(`${AC_URL}/api/3/contactTags`);
      const body = JSON.parse(opts.body);
      expect(body).toEqual({
        contactTag: { contact: '123', tag: '20' },
      });
      // Verify string type explicitly (Pitfall 3)
      expect(typeof body.contactTag.contact).toBe('string');
      expect(typeof body.contactTag.tag).toBe('string');
    });
  });

  describe('resolveListId', () => {
    it('GET /lists with filter and returns numeric ID', async () => {
      const mockFetch = mockFetchResponse({
        lists: [{ id: '99', name: 'EN_BRAND_000000_SUB_EMAIL' }],
      });
      vi.stubGlobal('fetch', mockFetch);

      const id = await resolveListId('EN_BRAND_000000_SUB_EMAIL');

      expect(id).toBe(99);
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('/api/3/lists');
      expect(url).toContain('filters%5Bname%5D=EN_BRAND_000000_SUB_EMAIL');
    });

    it('matches exact name when AC returns multiple partial matches', async () => {
      // AC's filters[name] is a substring match: searching "EN_BRAND_000000_SUB"
      // also returns "EN_BRAND_000000_SUB_EMAIL". Must resolve the exact name.
      const mockFetch = mockFetchResponse({
        lists: [
          { id: '201', name: 'EN_BRAND_000000_SUB_EMAIL' },
          { id: '200', name: 'EN_BRAND_000000_SUB' },
        ],
      });
      vi.stubGlobal('fetch', mockFetch);

      const id = await resolveListId('EN_BRAND_000000_SUB');

      expect(id).toBe(200);
    });

    it('throws if no matching list found', async () => {
      const mockFetch = mockFetchResponse({ lists: [] });
      vi.stubGlobal('fetch', mockFetch);

      await expect(resolveListId('NONEXISTENT')).rejects.toThrow();
    });

    it('throws if only partial (non-exact) matches are returned', async () => {
      const mockFetch = mockFetchResponse({
        lists: [{ id: '201', name: 'EN_BRAND_000000_SUB_EMAIL' }],
      });
      vi.stubGlobal('fetch', mockFetch);

      await expect(resolveListId('EN_BRAND_000000_SUB')).rejects.toThrow();
    });

    it('caches resolved IDs', async () => {
      const mockFetch = mockFetchResponse({
        lists: [{ id: '99', name: 'EN_LIST' }],
      });
      vi.stubGlobal('fetch', mockFetch);

      await resolveListId('EN_LIST');
      await resolveListId('EN_LIST');

      expect(mockFetch).toHaveBeenCalledOnce();
    });
  });

  describe('resolveTagId', () => {
    it('GET /tags with search and returns ID for exact match', async () => {
      const mockFetch = mockFetchResponse({
        tags: [
          { tag: '#EN_BRAND_000000_SUB', id: '55' },
          { tag: '#EN_BRAND_000000_SUB_OLD', id: '56' },
        ],
      });
      vi.stubGlobal('fetch', mockFetch);

      const id = await resolveTagId('#EN_BRAND_000000_SUB');

      expect(id).toBe(55);
    });

    it('throws if no exact match found', async () => {
      const mockFetch = mockFetchResponse({ tags: [{ tag: 'OTHER', id: '1' }] });
      vi.stubGlobal('fetch', mockFetch);

      await expect(resolveTagId('EN_BUYERS')).rejects.toThrow();
    });

    it('caches resolved IDs', async () => {
      const mockFetch = mockFetchResponse({
        tags: [{ tag: 'EN_TAG', id: '10' }],
      });
      vi.stubGlobal('fetch', mockFetch);

      await resolveTagId('EN_TAG');
      await resolveTagId('EN_TAG');

      expect(mockFetch).toHaveBeenCalledOnce();
    });
  });
});

describe('AC client — high-level orchestrators', () => {
  beforeEach(() => {
    vi.stubEnv('ACTIVECAMPAIGN_API_URL', AC_URL);
    vi.stubEnv('ACTIVECAMPAIGN_API_KEY', AC_KEY);
    _resetCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe('addContactToEmailList', () => {
    it('syncs contact, resolves email list, adds to list for locale en', async () => {
      const calls: Array<[string, RequestInit]> = [];
      const mockFetch = vi.fn().mockImplementation((url: string, opts: RequestInit) => {
        calls.push([url, opts]);

        // syncContact
        if (url.includes('/contact/sync')) {
          return Promise.resolve({
            ok: true, status: 200,
            json: () => Promise.resolve({ contact: { id: '10' } }),
            text: () => Promise.resolve(''),
          });
        }
        // resolveListId
        if (url.includes('/lists')) {
          return Promise.resolve({
            ok: true, status: 200,
            json: () => Promise.resolve({
              lists: [{ id: '100', name: 'EN_BRAND_000000_SUB_EMAIL' }],
            }),
            text: () => Promise.resolve(''),
          });
        }
        // addContactToList
        if (url.includes('/contactLists')) {
          return Promise.resolve({
            ok: true, status: 200,
            json: () => Promise.resolve({ contactList: {} }),
            text: () => Promise.resolve(''),
          });
        }
        return Promise.reject(new Error(`Unexpected: ${url}`));
      });
      vi.stubGlobal('fetch', mockFetch);

      await addContactToEmailList('user@test.com', 'en');

      // 3 calls: sync, resolve list, add to list
      expect(mockFetch).toHaveBeenCalledTimes(3);

      // Verify list name uses EN prefix
      const listResolveUrl = calls[1][0];
      expect(listResolveUrl).toContain('EN_BRAND_000000_SUB_EMAIL');

      // Verify addContactToList payload
      const addBody = JSON.parse(calls[2][1].body as string);
      expect(addBody.contactList.contact).toBe(10);
      expect(addBody.contactList.list).toBe(100);
      expect(addBody.contactList.status).toBe(1);
    });

    it('catches errors and logs (does not throw) -- AC-06', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const mockFetch = vi.fn().mockRejectedValue(new Error('network down'));
      vi.stubGlobal('fetch', mockFetch);

      // Should NOT throw
      await addContactToEmailList('user@test.com', 'en');

      expect(consoleSpy).toHaveBeenCalledOnce();
      expect(consoleSpy.mock.calls[0][0]).toContain('[activecampaign]');
    });
  });

  describe('tagBuyer', () => {
    it('syncs, resolves 4 IDs, adds subscriber list, removes email list, adds 2 tags for locale el (GR)', async () => {
      let callIndex = 0;
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        callIndex++;

        // Call 1: syncContact
        if (url.includes('/contact/sync')) {
          return Promise.resolve({
            ok: true, status: 200,
            json: () => Promise.resolve({ contact: { id: '20' } }),
            text: () => Promise.resolve(''),
          });
        }
        // Calls 2-5: resolveListId and resolveTagId
        if (url.includes('/lists')) {
          return Promise.resolve({
            ok: true, status: 200,
            json: () => {
              // Distinguish by list name in URL
              if (url.includes('SUB_EMAIL')) {
                return Promise.resolve({
                  lists: [{ id: '201', name: 'GR_BRAND_000000_SUB_EMAIL' }],
                });
              }
              return Promise.resolve({
                lists: [{ id: '200', name: 'GR_BRAND_000000_SUB' }],
              });
            },
            text: () => Promise.resolve(''),
          });
        }
        if (url.includes('/tags')) {
          return Promise.resolve({
            ok: true, status: 200,
            json: () => {
              if (url.includes('BRAND')) {
                return Promise.resolve({ tags: [{ tag: '#GR_BRAND_000000_SUB', id: '300' }] });
              }
              return Promise.resolve({ tags: [{ tag: '#GR customers', id: '301' }] });
            },
            text: () => Promise.resolve(''),
          });
        }
        // Calls 6-9: addContactToList, removeContactFromList, addTagToContact x2
        if (url.includes('/contactLists') || url.includes('/contactTags')) {
          return Promise.resolve({
            ok: true, status: 200,
            json: () => Promise.resolve({}),
            text: () => Promise.resolve(''),
          });
        }
        return Promise.reject(new Error(`Unexpected: ${url}`));
      });
      vi.stubGlobal('fetch', mockFetch);

      await tagBuyer('buyer@test.com', 'el');

      // 1 sync + 4 resolves + 4 mutations = 9 calls
      expect(mockFetch.mock.calls.length).toBe(9);

      // Verify the subscriber list resolve used GR prefix
      const listCalls = mockFetch.mock.calls.filter(
        (call) => (call[0] as string).includes('/lists'),
      );
      expect(listCalls.some((call) => (call[0] as string).includes('GR_BRAND_000000_SUB'))).toBe(true);
      expect(listCalls.some((call) => (call[0] as string).includes('GR_BRAND_000000_SUB_EMAIL'))).toBe(true);
    });

    it('propagates errors to caller for proper error handling', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('network down'));
      vi.stubGlobal('fetch', mockFetch);

      await expect(tagBuyer('buyer@test.com', 'el')).rejects.toThrow('network down');
    });

    it('attempts later buyer steps but throws when one list mutation fails', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      let contactListMutation = 0;
      const mockFetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
        if (url.includes('/contact/sync')) {
          return Promise.resolve({
            ok: true, status: 200,
            json: () => Promise.resolve({ contact: { id: '20' } }),
            text: () => Promise.resolve(''),
          });
        }
        if (url.includes('/lists')) {
          const emailList = url.includes('SUB_EMAIL');
          return Promise.resolve({
            ok: true, status: 200,
            json: () => Promise.resolve({
              lists: [{
                id: emailList ? '201' : '200',
                name: emailList
                  ? 'GR_BRAND_000000_SUB_EMAIL'
                  : 'GR_BRAND_000000_SUB',
              }],
            }),
            text: () => Promise.resolve(''),
          });
        }
        if (url.includes('/tags')) {
          const buyerTag = url.includes('BRAND');
          return Promise.resolve({
            ok: true, status: 200,
            json: () => Promise.resolve({
              tags: [{
                id: buyerTag ? '300' : '301',
                tag: buyerTag
                  ? '#GR_BRAND_000000_SUB'
                  : '#GR customers',
              }],
            }),
            text: () => Promise.resolve(''),
          });
        }
        if (url.includes('/contactLists')) {
          contactListMutation += 1;
          if (contactListMutation === 1) {
            return Promise.resolve({
              ok: false, status: 400,
              text: () => Promise.resolve('bad list mutation'),
            });
          }
          return Promise.resolve({
            ok: true, status: 200,
            json: () => Promise.resolve({}),
            text: () => Promise.resolve(''),
          });
        }
        if (url.includes('/contactTags')) {
          return Promise.resolve({
            ok: true, status: 200,
            json: () => Promise.resolve({}),
            text: () => Promise.resolve(''),
          });
        }
        return Promise.reject(new Error(`Unexpected: ${url} ${String(options?.method)}`));
      });
      vi.stubGlobal('fetch', mockFetch);

      await expect(tagBuyer('buyer@test.com', 'el')).rejects.toThrow(
        'subscribe to buyer list: ActiveCampaign API error 400',
      );
      expect(mockFetch.mock.calls.filter(
        (call) => (call[0] as string).includes('/contactTags'),
      )).toHaveLength(2);
      expect(consoleSpy).toHaveBeenCalled();
    });
  });
});
