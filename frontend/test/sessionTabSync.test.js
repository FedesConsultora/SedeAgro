import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createSessionTabSync, isSessionTabSignal, SESSION_TAB_KEY,
  shouldRecheckOnForeground, FOREGROUND_RECHECK_MS, UNVERIFIED_FOREGROUND_RECHECK_MS
} from '../src/services/sessionTabSync.js';

function browserPair(withBroadcast = true) {
  const all = [];
  const channels = new Set();
  const values = new Map();
  class Channel {
    constructor(name) { this.name = name; this.handlers = new Set(); channels.add(this); }
    addEventListener(type, cb) { if (type === 'message') this.handlers.add(cb); }
    removeEventListener(type, cb) { if (type === 'message') this.handlers.delete(cb); }
    postMessage(data) {
      for (const other of channels) if (other !== this && other.name === this.name) {
        for (const fn of other.handlers) fn({ data });
      }
    }
    close() { channels.delete(this); }
  }
  const make = () => {
    const listeners = new Map();
    const browser = {
      crypto: { randomUUID },
      ...(withBroadcast ? { BroadcastChannel: Channel } : {}),
      addEventListener(event, cb) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(cb);
      },
      removeEventListener(event, cb) { listeners.get(event)?.delete(cb); },
      dispatch(type, event) { for (const cb of listeners.get(type) || []) cb(event); },
      localStorage: {
        setItem(key, value) {
          values.set(key, value);
          for (const other of all) if (other !== browser) {
            other.dispatch('storage', { key, newValue: value });
          }
        },
        removeItem(key) {
          values.delete(key);
          for (const other of all) if (other !== browser) {
            other.dispatch('storage', { key, newValue: null });
          }
        }
      }
    };
    all.push(browser);
    return browser;
  };
  return { a: make(), b: make(), values };
}

test('signals never carry tenant, user, token, cookie or protected information', () => {
  const { a, b, values } = browserPair();
  const events = [];
  const original = b.localStorage.setItem;
  b.localStorage.setItem = original;
  const other = createSessionTabSync(() => events.push('received'), b);
  const sender = createSessionTabSync(() => events.push('self'), a);
  sender.publish();
  assert.deepEqual(events, ['received'], 'broadcast + storage must be deduplicated');
  assert.equal(values.has(SESSION_TAB_KEY), false, 'temporary storage signal must be cleared');
  assert.equal(isSessionTabSignal({
    kind: 'session-transition', source: 'opaque', nonce: randomUUID()
  }), true);
  for (const malformed of [
    null, {}, { kind: 'session-transition' },
    { kind: 'session-transition', source: 'x', nonce: randomUUID(), token: 'secret' },
    { kind: 'session-transition', source: 'x', nonce: 'not-uuid' }
  ]) assert.equal(isSessionTabSignal(malformed), false);
  sender.close();
  other.close();
});

test('storage fallback works without BroadcastChannel and closing unsubscribes', () => {
  const { a, b } = browserPair(false);
  let deliveries = 0;
  const sender = createSessionTabSync(() => {}, a);
  const listener = createSessionTabSync(() => { deliveries++; }, b);
  sender.publish();
  assert.equal(deliveries, 1);
  listener.close();
  sender.publish();
  assert.equal(deliveries, 1);
  sender.close();
});

test('foreground revalidation is throttled and never forces an offline field session', () => {
  assert.equal(shouldRecheckOnForeground(0, 1000, true, true), true);
  assert.equal(shouldRecheckOnForeground(1000, 1000 + FOREGROUND_RECHECK_MS - 1, true, true), false);
  assert.equal(shouldRecheckOnForeground(1000, 1000 + FOREGROUND_RECHECK_MS, true, true), true);
  assert.equal(shouldRecheckOnForeground(0, FOREGROUND_RECHECK_MS, false, true), false);
  assert.equal(shouldRecheckOnForeground(0, FOREGROUND_RECHECK_MS, true, false), false);
  assert.equal(shouldRecheckOnForeground(0, Number.NaN, true, true), false);
});

test('suspended tab recovers unverified server identity promptly on foreground', () => {
  const last = 10_000;
  assert.equal(shouldRecheckOnForeground(last,
    last + UNVERIFIED_FOREGROUND_RECHECK_MS - 1, true, true, true), false,
  'avoid rapid foreground focus thrashing during a network outage');
  assert.equal(shouldRecheckOnForeground(last,
    last + UNVERIFIED_FOREGROUND_RECHECK_MS, true, true, true), true,
  'do not wait 60 seconds to verify a new cross-tab cookie');
  assert.equal(shouldRecheckOnForeground(last,
    last + UNVERIFIED_FOREGROUND_RECHECK_MS, true, true, false), false,
  'same already-verified identity must still use normal 60-second throttling');
  assert.equal(shouldRecheckOnForeground(last,
    last + FOREGROUND_RECHECK_MS, true, true, false), true);
  assert.equal(shouldRecheckOnForeground(last,
    last + FOREGROUND_RECHECK_MS, false, true, true), false,
  'background tab must not silently authenticate or render hidden private data');
  assert.equal(shouldRecheckOnForeground(last,
    last + FOREGROUND_RECHECK_MS, true, false, true), false,
  'local offline vault must never become a server session');
  assert.equal(shouldRecheckOnForeground(last,
    last - 1, true, true, true), false,
  'backwards clock must not bypass the minimum recheck interval');
});
