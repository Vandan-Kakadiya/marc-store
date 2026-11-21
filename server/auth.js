import { createHash, timingSafeEqual } from 'node:crypto';
import {
  CheckoutError,
  fail,
  json,
  seal,
  secret,
  sha256Pattern,
  siteURL,
  unseal
} from './common.js';

const stateCookie = '__Host-marc-vercel-login';
const sessionCookie = '__Host-marc-vercel-user';
const sessionPurpose = 'buyer session v2';
const sessionSeconds = 20 * 60;
const callbackPath = '/api/auth/callback';
function getCookie(req, name) {
  const prefix = name + '=';
  return (
    (req.headers.get('cookie') || '')
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith(prefix))
      ?.slice(prefix.length) || ''
  );
}
function setCookie(name, value, age) {
  return (
    name +
    '=' +
    value +
    '; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=' +
    age
  );
}
function redirect(target, cookies) {
  const headers = new Headers({
    location: target,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer'
  });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(null, { status: 303, headers });
}
export function loginReady(env) {
  return !!(
    siteURL(env.MARC_SITE_URL) &&
    sha256Pattern.test(env.MARC_SESSION_KEY || '') &&
    env.GOOGLE_CLIENT_ID &&
    env.GOOGLE_CLIENT_SECRET
  );
}
export function getUser(req, env) {
  return unseal(
    getCookie(req, sessionCookie),
    sessionPurpose,
    env.MARC_SESSION_KEY || '',
    3600
  );
}
export function logout() {
  return json({ ok: true }, 200, {
    'set-cookie': setCookie(sessionCookie, '', 0)
  });
}
function verifyHost(req, env) {
  if (req.method !== 'GET')
    fail(405, 'Return to the checkout page to sign in.');
  const current = new URL(req.url);
  if (!loginReady(env) || current.origin !== siteURL(env.MARC_SITE_URL))
    fail(503, 'Open checkout at the official MARC store address.');
  return current;
}
function loginError(error) {
  const message =
    error instanceof CheckoutError
      ? error.message
      : 'Google sign-in could not finish. Try again from checkout.';
  return new Response(
    '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>MARC sign-in</title><main><h1>Google sign-in</h1><p>' +
      message +
      '</p><a href="/checkout.html">Back to checkout</a></main></html>',
    {
      status: error instanceof CheckoutError ? error.status : 503,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer'
      }
    }
  );
}
export function createAuth({ env, fetcher = fetch }) {
  return {
    async start(req) {
      try {
        const current = verifyHost(req, env);
        const state = secret(),
          verifier = secret();
        const challenge = createHash('sha256')
          .update(verifier)
          .digest('base64url');
        const back =
          current.searchParams.get('orders') === '1'
            ? '/checkout.html?orders=1'
            : '/checkout.html';
        const token = seal(
          { state, verifier, back, expires: Date.now() + 600000 },
          'google login',
          env.MARC_SESSION_KEY
        );
        const google = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        google.search = new URLSearchParams({
          client_id: env.GOOGLE_CLIENT_ID,
          redirect_uri: current.origin + callbackPath,
          response_type: 'code',
          scope: 'openid email profile',
          state,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          prompt: 'select_account'
        });
        return redirect(google.href, [setCookie(stateCookie, token, 600)]);
      } catch (e) {
        return loginError(e);
      }
    },
    async callback(req) {
      try {
        const current = verifyHost(req, env);
        const token = unseal(
          getCookie(req, stateCookie),
          'google login',
          env.MARC_SESSION_KEY,
          2500
        );
        const state = current.searchParams.get('state') || '';
        if (
          !token ||
          !/^[a-zA-Z0-9_-]{43}$/.test(state) ||
          !timingSafeEqual(
            Buffer.from(state, 'utf8'),
            Buffer.from(token.state, 'utf8')
          )
        )
          fail(401, 'This sign-in expired. Return to checkout and try again.');
        const clear = setCookie(stateCookie, '', 0);
        if (current.searchParams.has('error'))
          return redirect(token.back, [clear]);
        const code = current.searchParams.get('code');
        if (!code) fail(401, 'Google did not complete sign-in.');
        const response = await fetcher('https://oauth2.googleapis.com/token', {
          method: 'POST',
          body: new URLSearchParams({
            client_id: env.GOOGLE_CLIENT_ID,
            client_secret: env.GOOGLE_CLIENT_SECRET,
            redirect_uri: current.origin + callbackPath,
            code,
            code_verifier: token.verifier,
            grant_type: 'authorization_code'
          }),
          signal: AbortSignal.timeout(9500),
          redirect: 'error'
        });
        if (!response.ok)
          fail(
            401,
            'Google sign-in could not finish. Try again from checkout.'
          );
        const oauth = await response.json();
        if (typeof oauth.access_token !== 'string' || !oauth.access_token)
          fail(401, 'Google sign-in could not finish.');
        const profile = await fetcher(
          'https://openidconnect.googleapis.com/v1/userinfo',
          {
            headers: { authorization: 'Bearer ' + oauth.access_token },
            signal: AbortSignal.timeout(9500),
            redirect: 'error'
          }
        );
        if (!profile.ok) fail(401, 'Google could not confirm your account.');
        const { sub, email, email_verified, name, hd } = await profile.json();
        if (
          typeof sub !== 'string' ||
          !sub ||
          sub.length > 255 ||
          typeof email !== 'string' ||
          email.length > 254 ||
          !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ||
          email_verified !== true
        )
          fail(403, 'Use a Google account with a verified email address.');
        const session = seal(
          {
            sub,
            email,
            googleEmail:
              /@gmail\.com$/i.test(email) || (typeof hd === 'string' && !!hd),
            name: typeof name === 'string' ? name.slice(0, 120) : '',
            expires: Date.now() + sessionSeconds * 1000
          },
          sessionPurpose,
          env.MARC_SESSION_KEY
        );
        return redirect(token.back, [
          clear,
          setCookie(sessionCookie, session, sessionSeconds)
        ]);
      } catch (e) {
        return loginError(e);
      }
    }
  };
}
