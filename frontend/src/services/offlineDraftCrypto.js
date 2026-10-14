// Web Crypto AES-256-GCM for browser-local drafts. The key remains
// non-extractable and is saved as CryptoKey in IndexedDB (not in source/JWT).
// This protects the serialized bytes at rest; same-origin script executing
// in the browser can still request decryption. It is NOT end-to-end encryption.
const VERSION = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function isSealedRecord(record) {
  return Boolean(record?.sealed?.version === VERSION &&
    record.sealed.iv && record.sealed.ciphertext);
}

function aad(record) {
  return encoder.encode(`sedeagro:offline:v1:${record.scope}:${record.id}`);
}

export async function generateLocalKey(webCrypto = globalThis.crypto) {
  if (!webCrypto?.subtle || !webCrypto.getRandomValues) {
    throw new Error('Este navegador no permite cifrar borradores. Usá HTTPS en un navegador actualizado.');
  }
  return webCrypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function sealOfflineDraft(record, key, webCrypto = globalThis.crypto) {
  if (!record?.id || !record?.scope || !record.id.startsWith(`${record.scope}:`)) {
    throw new Error('El borrador no tiene una identidad de usuario y empresa válida.');
  }
  if (!webCrypto?.subtle || !webCrypto.getRandomValues) {
    throw new Error('El cifrado del navegador no está disponible.');
  }
  const iv = webCrypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(record));
  const ciphertext = await webCrypto.subtle.encrypt({
    name: 'AES-GCM', iv, additionalData: aad(record), tagLength: 128
  }, key, plaintext);
  return {
    id: record.id,
    scope: record.scope,
    createdAt: record.createdAt,
    sealed: {
      version: VERSION,
      iv: Array.from(iv),
      ciphertext
    }
  };
}

export async function openOfflineDraft(record, key, webCrypto = globalThis.crypto) {
  if (!isSealedRecord(record)) {
    throw new Error('El borrador cifrado tiene un formato incompatible.');
  }
  try {
    const ciphertext = record.sealed.ciphertext;
    const plaintext = await webCrypto.subtle.decrypt({
      name: 'AES-GCM',
      iv: new Uint8Array(record.sealed.iv),
      additionalData: aad(record),
      tagLength: 128
    }, key, ciphertext);
    const item = JSON.parse(decoder.decode(plaintext));
    if (item.id !== record.id || item.scope !== record.scope ||
        item.idempotencyKey !== item.body?.idempotency_key ||
        item.body?.operations?.[0]?.payload?.scouting_run_id !== item.runId) {
      throw new Error('La identidad del borrador es inconsistente.');
    }
    return item;
  } catch {
    throw new Error('No se pudo descifrar el borrador local. No se eliminaron los datos; revisá el almacenamiento del navegador.');
  }
}
