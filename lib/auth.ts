import { randomBytes, pbkdf2 as nodePbkdf2 } from 'crypto';
import { cookies, headers } from 'next/headers';
import { prisma } from './db';

const SESSION_COOKIE = 'session_token';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

const PBKDF2_ITERATIONS = 150000;
const PBKDF2_KEY_LENGTH = 32;
const PBKDF2_DIGEST = 'sha256';

export interface UserRecord {
  id: string;
  email: string;
  createdAt: Date;
}

export function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = randomBytes(16).toString('hex');
    const peppered = Buffer.concat([
      Buffer.from(password, 'utf8'),
      Buffer.from(process.env.AUTH_PEPPER ?? '', 'utf8'),
    ]);
    nodePbkdf2(
      peppered,
      salt,
      PBKDF2_ITERATIONS,
      PBKDF2_KEY_LENGTH,
      PBKDF2_DIGEST,
      (err: Error | null, derivedKey: Buffer) => {
        if (err) return reject(err);
        resolve(`pbkdf2:${PBKDF2_DIGEST}:${PBKDF2_ITERATIONS}:${salt}:${derivedKey.toString('hex')}`);
      },
    );
  });
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2') return false;
  const [, digest, iterationsStr, salt, expectedHash] = parts;
  const iterations = Number(iterationsStr);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  
  // Try with current pepper first
  const peppered = Buffer.concat([
    Buffer.from(password, 'utf8'),
    Buffer.from(process.env.AUTH_PEPPER ?? '', 'utf8'),
  ]);
  const derivedKey = await pbkdf2Promise(peppered, salt, iterations, PBKDF2_KEY_LENGTH, digest);
  const expectedBuf = Buffer.from(expectedHash, 'hex');
  
  if (expectedBuf.length !== derivedKey.length) return false;
  let isEqual = true;
  for (let i = 0; i < expectedBuf.length; i++) {
    isEqual = isEqual && expectedBuf[i] === derivedKey[i];
  }
  
  // If it matches with current pepper, return true
  if (isEqual) return true;
  
  // Backwards compatibility: try without pepper for accounts created before AUTH_PEPPER was set
  const unpeppered = Buffer.from(password, 'utf8');
  const derivedKeyUnpeppered = await pbkdf2Promise(unpeppered, salt, iterations, PBKDF2_KEY_LENGTH, digest);
  
  if (expectedBuf.length !== derivedKeyUnpeppered.length) return false;
  let isEqualUnpeppered = true;
  for (let i = 0; i < expectedBuf.length; i++) {
    isEqualUnpeppered = isEqualUnpeppered && expectedBuf[i] === derivedKeyUnpeppered[i];
  }
  
  return isEqualUnpeppered;
}

function pbkdf2Promise(
  password: Buffer,
  salt: string,
  iterations: number,
  keylen: number,
  digest: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodePbkdf2(
      password,
      salt,
      iterations,
      keylen,
      digest,
      (err: Error | null, derivedKey: Buffer) => {
        if (err) return reject(err);
        resolve(derivedKey);
      },
    );
  });
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);

  await prisma.session.create({
    data: {
      userId,
      token,
      expiresAt,
    },
  });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    // Secure only when the request actually arrived over HTTPS (directly or
    // via a TLS-terminating proxy). Browsers silently DROP Secure cookies on
    // plain-http origins, which would break login on LAN/Tailscale IPs when
    // the production build is served without TLS. localhost is always
    // treated as secure by browsers, so this does not weaken that case.
    secure: await isRequestSecure(),
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE_SECONDS,
    path: '/',
  });

  return token;
}

export async function getCurrentUser(): Promise<UserRecord | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;

  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { token },
    include: { user: { select: { id: true, email: true, createdAt: true } } },
  });

  if (!session) return null;

  if (session.expiresAt < new Date()) {
    await prisma.session.delete({ where: { token } }).catch(() => {});
    return null;
  }

  return session.user;
}

export async function invalidateSession(token: string): Promise<void> {
  await prisma.session.delete({ where: { token } }).catch(() => {});
}

/**
 * True when the current request arrived over HTTPS: either directly
 * (x-forwarded-proto set by a TLS-terminating proxy) or, when no proxy
 * headers exist, when the Host is not a plain-HTTP LAN origin. Never true
 * for http:// LAN/Tailscale hosts, always fine for localhost.
 */
async function isRequestSecure(): Promise<boolean> {
  const h = await headers();
  const proto = h.get('x-forwarded-proto');
  if (proto) return proto.split(',')[0].trim() === 'https';
  // No proxy involved: browsers treat localhost/127.0.0.1 as a secure
  // context even over http; any other host on http is NOT secure.
  const host = h.get('host') ?? '';
  return host.startsWith('localhost:') || host.startsWith('127.0.0.1:') || host === 'localhost' || host === '127.0.0.1';
}

export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}

export async function logout(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (token) {
    await invalidateSession(token);
  }
  await clearSessionCookie();
}

export function getSessionCookieName(): string {
  return SESSION_COOKIE;
}
