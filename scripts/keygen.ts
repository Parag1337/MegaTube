/**
 * Generate a MEGA_SESSION_ENCRYPTION_KEY.
 *
 *   npm run keygen
 *
 * Print the value to .env (the .env file is git-ignored) and NEVER commit it.
 * If you rotate the key, all previously stored MEGA sessions and file keys
 * become unreadable - users will need to reconnect their MEGA accounts.
 */

import crypto from 'node:crypto';

const key = crypto.randomBytes(32).toString('hex');
console.log('MEGA_SESSION_ENCRYPTION_KEY=' + key);
console.error('Add the line above to your .env file. Never commit the key.');
