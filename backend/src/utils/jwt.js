import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export function signSession(payload) {
  return jwt.sign(payload, env.jwtSecret, { expiresIn: '12h' });
}

export function verifySession(token) {
  return jwt.verify(token, env.jwtSecret);
}
