// MOB-05: opt-in local field access, NOT authentication. A strong secret
// unlocks a minimal, previously server-verified scope for LOCAL encrypted
// drafts only. No cookie, bearer, entitlements or reusable server authority
// is saved. The browser origin's own scripts remain inside the threat model.
import { offlineQueue } from './offlineQueue.js';
import { indexedDbQueueStore } from './offlineQueueStore.js';
import { sessionScope } from './offlineSyncModel.js';

const DB = 'sedeagro-field-offline-vault';
const STORE = 'offline-vault';
const RECORD = 'active';
const VERSION = 1;
const AAD = new TextEncoder().encode('sedeagro:field-offline-vault:v1');
const ITERATIONS = 310_000;
export const OFFLINE_VAULT_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLES = new Set(['tenant_admin', 'agronomic_coordinator', 'scout']);
const capabilities = new WeakMap();
let generation = 0;
let failures = 0;
let blockedUntil = 0;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function localFieldScope(profile) {
  if (!profile?.authenticated ||
      !UUID.test(profile?.tenant?.id || '') ||
      !UUID.test(profile?.user?.id || '') ||
      !UUID.test(profile?.membership?.id || '') ||
      !ROLES.has(profile?.membership?.roleCode) ||
      profile.membership.status !== 'active' ||
      !Array.isArray(profile.entitlements) ||
      !profile.entitlements.includes('scouting')) return null;
  return sessionScope(profile);
}

export function validateLocalFieldPassphrase(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128 ||
      !value.trim() || value.trim().length < 12) {
    throw new Error('Elegí una frase de acceso local de 12 a 128 caracteres.');
  }
  return value;
}

async function deriveKey(passphrase, salt, webCrypto = globalThis.crypto) {
  const material = await webCrypto.subtle.importKey('raw',
    encoder.encode(validateLocalFieldPassphrase(passphrase)), 'PBKDF2', false, ['deriveKey']);
  return webCrypto.subtle.deriveKey({
    name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256'
  }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function sealFieldProfile(profile, secret, now = Date.now(), webCrypto = globalThis.crypto) {
  const scope = localFieldScope(profile);
  if (!scope || !Number.isFinite(now) || !webCrypto?.subtle || !webCrypto.getRandomValues) {
    throw new Error('No hay identidad verificada o cifrado disponible para el acceso local.');
  }
  const salt = webCrypto.getRandomValues(new Uint8Array(16));
  const iv = webCrypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(secret, salt, webCrypto);
  const plaintext = encoder.encode(JSON.stringify({
    version: VERSION, scope, tenantId: profile.tenant.id, userId: profile.user.id,
    membershipId: profile.membership.id, role: profile.membership.roleCode,
    verifiedAt: now, validUntil: now + OFFLINE_VAULT_MAX_AGE_MS
  }));
  const ciphertext = await webCrypto.subtle.encrypt({
    name: 'AES-GCM', iv, additionalData: AAD, tagLength: 128
  }, key, plaintext);
  return { id: RECORD, version: VERSION, salt: [...salt], iv: [...iv], ciphertext };
}

export async function openFieldProfile(record, secret, now = Date.now(), webCrypto = globalThis.crypto) {
  // Never return row IDs or ciphertext to the UI on wrong secret.
  if (record?.version !== VERSION || record.id !== RECORD ||
      !Array.isArray(record.salt) || record.salt.length !== 16 ||
      !Array.isArray(record.iv) || record.iv.length !== 12 ||
      !(record.ciphertext instanceof ArrayBuffer) ||
      !webCrypto?.subtle) {
    throw new Error('El acceso local no está disponible o tiene un formato inválido.');
  }
  try {
    const key = await deriveKey(secret, new Uint8Array(record.salt), webCrypto);
    const bytes = await webCrypto.subtle.decrypt({
      name: 'AES-GCM', iv: new Uint8Array(record.iv),
      additionalData: AAD, tagLength: 128
    }, key, record.ciphertext);
    const profile = JSON.parse(decoder.decode(bytes));
    if (profile.version !== VERSION ||
        !UUID.test(profile.tenantId) || !UUID.test(profile.userId) ||
        !UUID.test(profile.membershipId) || !ROLES.has(profile.role) ||
        profile.scope !== `${profile.tenantId}:${profile.userId}` ||
        !Number.isSafeInteger(profile.verifiedAt) ||
        !Number.isSafeInteger(profile.validUntil) ||
        profile.validUntil - profile.verifiedAt !== OFFLINE_VAULT_MAX_AGE_MS ||
        profile.verifiedAt > now + 5000 || profile.validUntil <= now) {
      throw new Error('Expired or invalid local scope');
    }
    return profile;
  } catch {
    throw new Error('Frase incorrecta o acceso local vencido. Los borradores se conservan.');
  }
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB no está disponible. Los borradores no se modificaron.'));
      return;
    }
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onerror = () => reject(request.error || new Error('Error al abrir el acceso local.'));
    request.onblocked = () => reject(new Error('Cerrá otras pestañas e intentá de nuevo.'));
    request.onsuccess = () => resolve(request.result);
  });
}
async function transaction(mode, operation) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      let value;
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error || new Error('No se pudo guardar el acceso local.'));
      tx.onabort = () => reject(tx.error || new Error('Se canceló el acceso local.'));
      try {
        const request = operation(tx.objectStore(STORE));
        if (request) request.onsuccess = () => { value = request.result; };
      } catch (error) { tx.abort(); reject(error); }
    });
  } finally { db.close(); }
}

export async function enrollOfflineFieldVault(profile, passphrase) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error('Debés verificar tu sesión con el servidor antes de habilitar acceso local.');
  }
  const sealed = await sealFieldProfile(profile, passphrase);
  // Only one scoped identity is locally recoverable. Previous ciphertext is
  // overwritten atomically, never exposed via localStorage/tenantHint.
  await transaction('readwrite', store => store.put(sealed));
  lockOfflineFieldVault();
  return true;
}

export function lockOfflineFieldVault() {
  generation += 1;
}

function checkedCapability(ticket) {
  const state = ticket && typeof ticket === 'object' ? capabilities.get(ticket) : null;
  if (!state || state.generation !== generation ||
      Date.now() >= state.validUntil || Date.now() >= state.unlockedUntil ||
      typeof navigator !== 'undefined' && navigator.onLine !== false) {
    throw new Error('El acceso local está bloqueado. Desbloquealo de nuevo sin conexión.');
  }
  return state;
}

export async function unlockOfflineFieldVault(passphrase) {
  if (typeof navigator !== 'undefined' && navigator.onLine !== false) {
    throw new Error('Este acceso sólo funciona sin conexión. Validá tu sesión en línea.');
  }
  if (Date.now() < blockedUntil) throw new Error('Demasiados intentos. Volvé a probar más tarde.');
  const record = await transaction('readonly', store => store.get(RECORD));
  if (!record) throw new Error('No se configuró acceso local. Configuralo con la sesión verificada y conexión.');
  let profile;
  try {
    profile = await openFieldProfile(record, passphrase);
  } catch (error) {
    if (++failures >= 5) { blockedUntil = Date.now() + 60_000; failures = 0; }
    throw error;
  }
  failures = 0;
  const ticket = Object.freeze({});
  capabilities.set(ticket, {
    scope: profile.scope, tenantId: profile.tenantId, userId: profile.userId,
    role: profile.role, validUntil: profile.validUntil,
    unlockedUntil: Date.now() + 15 * 60_000, generation
  });
  return ticket;
}

export async function listOfflineFieldDrafts(ticket) {
  const state = checkedCapability(ticket);
  const rows = await indexedDbQueueStore.list(state.scope);
  // Fence async decrypt after a lock/visibility/account transition.
  if (checkedCapability(ticket) !== state) throw new Error('El acceso local cambió.');
  return rows;
}

export async function queueOfflineFieldObservation(ticket, runId, values) {
  const state = checkedCapability(ticket);
  const drafts = await indexedDbQueueStore.list(state.scope);
  if (checkedCapability(ticket) !== state) throw new Error('El acceso local cambió.');
  if (!UUID.test(runId) || !drafts.some(item => item.runId === runId)) {
    throw new Error('Sólo podés continuar recorridas con borradores anteriores en este dispositivo.');
  }
  // This local-only identity is NEVER installed into SessionContext or
  // handed to the transport. queueObservation only seals IndexedDB; no POST
  // is possible from this API. Server authorization remains mandatory at sync.
  const localIdentity = {
    authenticated: true, tenant: { id: state.tenantId },
    user: { id: state.userId }
  };
  const result = await offlineQueue.queueObservation(localIdentity, runId, values);
  if (checkedCapability(ticket) !== state) {
    // The encrypted row survives a tab transition; NEVER claim a stale ACK.
    throw new Error('El acceso local se bloqueó durante el guardado. Revisá la cola luego.');
  }
  return result;
}

export async function clearOfflineFieldVault() {
  lockOfflineFieldVault();
  await transaction('readwrite', store => store.delete(RECORD));
}
