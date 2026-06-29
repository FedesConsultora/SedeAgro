import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

export function runWithTenantContext(context, callback) {
  return storage.run({ ...context }, callback);
}

export function getTenantContext() {
  return storage.getStore() || {};
}

export function getTenantId() {
  return getTenantContext().tenantId || null;
}

export function getActorId() {
  return getTenantContext().userId || null;
}

export function setActorId(userId) {
  const store = storage.getStore();
  if (store) store.userId = userId;
}
