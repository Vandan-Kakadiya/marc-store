import { createHmac } from 'node:crypto';

export function scriptEndpoint(raw) {
  try {
    const url = new URL(raw);
    if (
      url.origin === 'https://script.google.com' &&
      !url.username &&
      !url.password &&
      /^\/(?:a\/macros\/[A-Za-z0-9.-]+|macros)\/s\/[A-Za-z0-9_-]+\/exec$/.test(
        url.pathname
      ) &&
      !url.search &&
      !url.hash
    )
      return url.href;
  } catch {}
  return '';
}

export async function callScript(
  env,
  action,
  data,
  fetcher = fetch,
  timeout = 42000
) {
  const endpoint = scriptEndpoint(env.MARC_SCRIPT_URL);
  if (!endpoint || !/^[a-f0-9]{64}$/.test(env.MARC_SCRIPT_SECRET || ''))
    throw Error('Check MARC_SCRIPT_URL and MARC_SCRIPT_SECRET.');
  const issuedAt = Date.now(),
    payload = JSON.stringify({ action, data });
  const signature = createHmac('sha256', env.MARC_SCRIPT_SECRET)
    .update(String(issuedAt) + '\n' + payload, 'utf8')
    .digest('hex');
  const signal = AbortSignal.timeout(timeout);
  // ContentService returns the result on a Google read-only redirect.
  let response = await fetcher(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ issuedAt, payload, signature }),
    redirect: 'manual',
    signal
  });
  if ([301, 302, 303].includes(response.status)) {
    const location = new URL(response.headers.get('location') || '', endpoint);
    if (
      location.origin !== 'https://script.googleusercontent.com' ||
      location.username ||
      location.password
    )
      throw Error('The Apps Script deployment must allow Anyone.');
    response = await fetcher(location.href, {
      method: 'GET',
      redirect: 'error',
      signal
    });
  }
  if (
    !response.ok ||
    !response.headers
      .get('content-type')
      ?.toLowerCase()
      .includes('application/json')
  )
    throw Error('Apps Script did not return a JSON receipt.');
  const result = await response.json();
  if (!result || typeof result.ok !== 'boolean')
    throw Error('Apps Script returned an invalid result.');
  return result;
}
