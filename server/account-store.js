import { createHmac } from 'node:crypto';
import * as blob from '@vercel/blob';
import { callScript } from './script-client.js';

const retention = { session: 1, bag: 30 };
export const sessionSeconds = 60 * 60;

export function accountKey(env, buyer) {
  return createHmac('sha256', env.MARC_SESSION_KEY)
    .update('MARC account state\n' + buyer.sub)
    .digest('hex');
}

export function createAccountStore(env, fetcher = fetch, sdk = blob) {
  if (!env.BLOB_READ_WRITE_TOKEN) {
    async function request(action, kind, key, details) {
      const result = await callScript(env, 'accountState', { action, kind, key, ...details }, fetcher, 9000);
      if (result.ok) return result.data;
      if (result.code === 'conflict') return false;
      throw Error('Account storage is temporarily unavailable.');
    }
    return {
      read: (kind, key) => request('read', kind, key),
      write: (kind, key, value, expected) => request('write', kind, key, { value, expected }),
      remove: (kind, key, expected) => request('remove', kind, key, { expected })
    };
  }

  const path = (kind, key) => 'marc/accounts/v1/' + kind + '/' + key + '.json';
  const access = () => ({ token: env.BLOB_READ_WRITE_TOKEN, abortSignal: AbortSignal.timeout(8000) });
  async function read(kind, key) {
    const item = await sdk.get(path(kind, key), { ...access(), access: 'private', useCache: false });
    return item ? { version: item.blob.etag, value: await new Response(item.stream).json() } : null;
  }
  return {
    read,
    async write(kind, key, value, expected) {
      try {
        const item = await sdk.put(path(kind, key), JSON.stringify(value), {
          ...access(),
          access: 'private',
          contentType: 'application/json',
          addRandomSuffix: false,
          allowOverwrite: expected !== null,
          ...(expected ? { ifMatch: expected } : {}),
          ttlDays: retention[kind]
        });
        return { version: item.etag, value };
      } catch (error) {
        if (error instanceof sdk.BlobPreconditionFailedError ||
            (expected === null && await read(kind, key))) return false;
        throw error;
      }
    },
    async remove(kind, key, expected) {
      try {
        await sdk.del(path(kind, key), { ...access(), ifMatch: expected });
        return true;
      } catch (error) {
        if (error instanceof sdk.BlobPreconditionFailedError) return false;
        throw error;
      }
    }
  };
}
