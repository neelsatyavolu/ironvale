import { describe, expect, it } from 'vitest';
import { connectSources, cspPatch } from '../../scripts/dev/app-csp.mjs';

const BASE = "'self' ipc: http://ipc.localhost data: blob:";

describe('connectSources', () => {
  it('adds nothing when no relay is configured', () => {
    expect(connectSources(BASE, '')).toBe(BASE);
    expect(connectSources(BASE, undefined)).toBe(BASE);
  });

  it('allows the relay over both the socket and its health check', () => {
    expect(connectSources(BASE, 'wss://signal.example.com')).toBe(`${BASE} https://signal.example.com wss://signal.example.com`);
    expect(connectSources(BASE, 'https://signal.example.com/')).toBe(`${BASE} https://signal.example.com wss://signal.example.com`);
  });

  it('keeps the port and drops any path', () => {
    expect(connectSources(BASE, 'wss://signal.example.com:8443/rooms')).toBe(
      `${BASE} https://signal.example.com:8443 wss://signal.example.com:8443`,
    );
  });

  it('uses the plain schemes for a local relay', () => {
    expect(connectSources(BASE, 'ws://127.0.0.1:8787')).toBe(`${BASE} http://127.0.0.1:8787 ws://127.0.0.1:8787`);
  });

  it('refuses anything that is not a relay address', () => {
    expect(() => connectSources(BASE, 'signal.example.com')).toThrow(/VITE_SIGNAL_URL/);
    expect(() => connectSources(BASE, 'ftp://signal.example.com')).toThrow(/VITE_SIGNAL_URL/);
    expect(() => connectSources(BASE, "wss://x.example.com' 'unsafe-inline")).toThrow(/VITE_SIGNAL_URL/);
  });
});

describe('cspPatch', () => {
  it('is empty without a relay, so the base policy stands', () => {
    expect(cspPatch(BASE, '')).toEqual({});
  });

  it('replaces only connect-src', () => {
    expect(cspPatch(BASE, 'wss://signal.example.com')).toEqual({
      app: { security: { csp: { 'connect-src': `${BASE} https://signal.example.com wss://signal.example.com` } } },
    });
  });
});
