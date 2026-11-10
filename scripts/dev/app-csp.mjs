// Works out the one part of the Mac app's content security policy that depends on the build:
// the two-player relay. Prints a Tauri config patch for `tauri build --config`.
// Usage: tauri build --config "$(node scripts/dev/app-csp.mjs)"   (npm run app:build does this)
// The relay address is the same VITE_SIGNAL_URL the web build reads (environment or .env files).
// With none set it prints {} and the app allows no connection that leaves the Mac.
// STUN and TURN need no entry: WebKit does not put ICE traffic under the policy.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SECURE = { 'wss:': true, 'https:': true, 'ws:': false, 'http:': false };

/** The policy's connect-src with the relay's origin added, for its WebSocket and its HTTP health check. */
export function connectSources(base, signalUrl) {
  const address = (signalUrl ?? '').trim();
  if (!address) return base;
  let url;
  try {
    url = new URL(address);
  } catch {
    throw new Error(`VITE_SIGNAL_URL is not a URL: ${address}`);
  }
  // A quote or a space would let the setting write its own policy.
  if (!(url.protocol in SECURE) || /['"\s;,]/.test(address)) {
    throw new Error(`VITE_SIGNAL_URL must be a wss://, https://, ws:// or http:// address: ${address}`);
  }
  const secure = SECURE[url.protocol];
  return `${base} ${secure ? 'https' : 'http'}://${url.host} ${secure ? 'wss' : 'ws'}://${url.host}`;
}

export function cspPatch(base, signalUrl) {
  const sources = connectSources(base, signalUrl);
  return sources === base ? {} : { app: { security: { csp: { 'connect-src': sources } } } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const { loadEnv } = await import('vite');
  const signalUrl = process.env.VITE_SIGNAL_URL ?? loadEnv('production', root, 'VITE_').VITE_SIGNAL_URL;
  const config = JSON.parse(await readFile(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const patch = cspPatch(config.app.security.csp['connect-src'], signalUrl);
  if (!signalUrl) process.stderr.write('VITE_SIGNAL_URL is not set: this build cannot reach a two-player relay.\n');
  process.stdout.write(JSON.stringify(patch));
}
