import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createSessionTabSync, isSessionTabSignal, SESSION_TAB_KEY, SESSION_TAB_WITNESS_KEY,
  shouldRecheckOnForeground, FOREGROUND_RECHECK_MS
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
      suspended: false,
      crypto: { randomUUID },
      ...(withBroadcast ? { BroadcastChannel: Channel } : {}),
      addEventListener(event, cb) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(cb);
      },
      removeEventListener(event, cb) { listeners.get(event)?.delete(cb); },
      dispatch(type, event) { for (const cb of listeners.get(type) || []) cb(event); },
      localStorage: {
        getItem(key) { return values.get(key) ?? null; },
        setItem(key, value) {
          values.set(key, value);
          for (const other of all) if (other !== browser && !other.suspended) {
            other.dispatch('storage', { key, newValue: value });
          }
        },
        removeItem(key) {
          values.delete(key);
          for (const other of all) if (other !== browser && !other.suspended) {
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
  const witness = JSON.parse(values.get(SESSION_TAB_WITNESS_KEY));
  assert.equal(isSessionTabSignal(witness), true);
  assert.deepEqual(Object.keys(witness).sort(), ['kind', 'nonce', 'source']);
  assert.ok(!JSON.stringify(witness).includes('tenant') &&
    !JSON.stringify(witness).includes('user') &&
    !JSON.stringify(witness).includes('token'));
  assert.equal(other.catchUp(), false, 'delivered events may not re-fire on foreground');
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

test('suspended tab recovers a missed transition from opaque witness exactly once', () => {
  const { a, b } = browserPair(false); // no BroadcastChannel
  let deliveries = 0;
  const sender = createSessionTabSync(() => {}, a);
  const receiver = createSessionTabSync(() => { deliveries++; }, b);
  b.suspended = true; // both transient storage events are lost by the tab
  sender.publish();
  sender.publish();
  assert.equal(deliveries, 0, 'a suspended tab must not receive transient events');
  b.suspended = false;
  assert.equal(receiver.catchUp(), true);
  assert.equal(deliveries, 1, 'a single /auth/me revalidation handles the latest cookie');
  assert.equal(receiver.catchUp(), false);
  assert.equal(deliveries, 1, 'foreground focus cannot cause duplicate revalidation');
  sender.close();
  receiver.close();
});

test('newly mounted tab does not replay a stale witness (it verifies its cookie on mount)', () => {
  const { a, b } = browserPair(false);
  const sender = createSessionTabSync(() => {}, a);
  sender.publish();
  let called = 0;
  const newReceiver = createSessionTabSync(() => { called++; }, b);
  assert.equal(newReceiver.catchUp(), false);
  assert.equal(called, 0);
  sender.publish();
  assert.equal(called, 1);
  assert.equal(newReceiver.catchUp(), false);
  newReceiver.close();
  sender.close();
});

test('opaque witness refuses malformed storage and falls back without throwing', () => {
  const { a, b, values } = browserPair(false);
  const receiver = createSessionTabSync(() => {}, b);
  values.set(SESSION_TAB_WITNESS_KEY, '{"kind":"session-transition","token":"secret"}');
  assert.equal(receiver.catchUp(), false);
  values.set(SESSION_TAB_WITNESS_KEY, '{broken JSON');
  assert.equal(receiver.catchUp(), false);
  b.localStorage.getItem = () => { throw new Error('Storage denied'); };
  assert.equal(receiver.catchUp(), false);
  receiver.close();
  const sender = createSessionTabSync(() => {}, a);
  assert.doesNotThrow(() => sender.publish());
  sender.close();
});
