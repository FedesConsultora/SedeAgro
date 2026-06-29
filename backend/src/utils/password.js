import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError } from './http.js';

const scrypt = promisify(scryptCallback);
const keyLength = 64;
const commonPasswords = new Set([
  '123456',
  '123456789',
  'password',
  'qwerty',
  'admin123',
  'cambiar-esto-123',
  'sedeagro123'
]);

export function validatePasswordStrength(password, userHints = []) {
  const normalized = String(password || '').toLowerCase();
  if (String(password || '').length < 12) {
    throw new HttpError(422, 'La contraseña debe tener al menos 12 caracteres.', undefined, 'WEAK_PASSWORD');
  }
  if (commonPasswords.has(normalized)) {
    throw new HttpError(422, 'La contraseña elegida es demasiado común.', undefined, 'WEAK_PASSWORD');
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    throw new HttpError(422, 'La contraseña debe combinar letras y números.', undefined, 'WEAK_PASSWORD');
  }
  for (const hint of userHints.filter(Boolean)) {
    const safeHint = String(hint).toLowerCase().split('@')[0];
    if (safeHint.length >= 4 && normalized.includes(safeHint)) {
      throw new HttpError(422, 'La contraseña no debe contener datos obvios del usuario.', undefined, 'WEAK_PASSWORD');
    }
  }
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, keyLength);
  return `scrypt$${salt}$${key.toString('hex')}`;
}

export async function verifyPassword(password, passwordHash) {
  const [scheme, salt, stored] = passwordHash.split('$');
  if (scheme !== 'scrypt' || !salt || !stored) return false;
  const key = await scrypt(password, salt, keyLength);
  const storedBuffer = Buffer.from(stored, 'hex');
  return storedBuffer.length === key.length && timingSafeEqual(storedBuffer, key);
}
