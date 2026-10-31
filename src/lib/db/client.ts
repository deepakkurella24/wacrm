import {
  NeonQueryBuilder,
  type NeonDatabaseClient,
  type QueryPayload,
  type QueryResult,
} from './neon-client';

let browserDbClient: NeonDatabaseClient | undefined;

/**
 * Browser-side database client.
 * Forwards queries to the secure /api/db endpoint which runs authenticated against Neon PostgreSQL.
 */
export function createClient(): NeonDatabaseClient {
  if (typeof window !== 'undefined' && browserDbClient) {
    return browserDbClient;
  }

  const client: NeonDatabaseClient = {
    from<T = any>(table: string): NeonQueryBuilder<T> {
      return new NeonQueryBuilder<T>(table, undefined, async (payload: QueryPayload) => {
        try {
          const res = await fetch('/api/db', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ payload }),
          });
          const json = (await res.json()) as QueryResult<T>;
          return json;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return { data: null as any, error: { message } };
        }
      });
    },
    async rpc<T = any>(name: string, args?: Record<string, unknown>): Promise<{ data: T | null; error: { message: string } | null }> {
      try {
        const res = await fetch('/api/db', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rpc: { name, args } }),
        });
        const json = (await res.json()) as { data: T | null; error: { message: string } | null };
        return json;
      } catch (err: unknown) {
        return { data: null, error: { message: err instanceof Error ? err.message : String(err) } };
      }
    },
    channel() {
      return {
        on() {
          return this;
        },
        subscribe(cb?: (status: string) => void) {
          cb?.('SUBSCRIBED');
          return this;
        },
      };
    },
    async removeChannel() {},
    storage: {
      from(bucket: string) {
        return {
          async upload() {
            return { error: null };
          },
          getPublicUrl(path: string) {
            return { data: { publicUrl: `/api/whatsapp/media/${path}` } };
          },
          async remove() {
            return { error: null };
          },
        };
      },
    },
    auth: {
      async getUser() {
        if (typeof window !== 'undefined') {
          const clerkUser = (window as any).Clerk?.user;
          if (clerkUser) {
            return {
              data: {
                user: {
                  id: clerkUser.id,
                  email: clerkUser.primaryEmailAddress?.emailAddress ?? '',
                  user_metadata: {
                    avatar_url: clerkUser.imageUrl,
                    full_name: clerkUser.fullName,
                  },
                },
              },
              error: null,
            };
          }
        }
        return { data: { user: null as any }, error: null as any };
      },
      async getSession() {
        return { data: { session: null as any }, error: null as any };
      },
      async signOut() {
        return { error: null as any };
      },
      async updateUser(attributes) {
        return { data: { user: attributes as any }, error: null as any };
      },
      onAuthStateChange() {
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
  };

  if (typeof window !== 'undefined') {
    browserDbClient = client;
  }

  return client;
}
