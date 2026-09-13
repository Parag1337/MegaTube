import 'dotenv/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import { prisma } from './lib/db';
import { decryptSecret } from './lib/mega/envelope';
import { withMegaSession } from './lib/sync/session-cache';
import { getTemporaryDownloadUrl } from './lib/mega/account';
import { keepAliveFetch } from './lib/net-resilience';
import { decrypt } from 'megajs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
const execFileAsync = promisify(execFile);
const v = await prisma.video.findUniqueOrThrow({ where: { id: 103 }, include: { megaAccount: true } });
const key = decryptSecret(v.fileKeyEncrypted!);
const { url } = await withMegaSession(v.megaAccountId!, v.megaAccount!.encryptedSession, async (s: any) => getTemporaryDownloadUrl(s, v.megaNodeId!));
const N = 64 * 1024 * 1024 - 1;
const res = await keepAliveFetch(`${url}/0-${N}`);
const d: any = decrypt(key, { start: 0, disableVerification: true });
await pipeline((Readable.fromWeb(res.body as any) as any).pipe(d), fs.createWriteStream('/tmp/v103pre.bin'));
console.log('prefix ok');
for (const t of [2, 46, 92, 138, 181]) {
  try {
    await execFileAsync('ffmpeg', ['-v','error','-y','-ss',String(t),'-i','/tmp/v103pre.bin','-frames:v','1','-q:v','4','-vf','scale=640:-1',`/tmp/v103-${t}.jpg`], { timeout: 120000, maxBuffer: 64*1024*1024 });
  } catch { /* file check decides */ }
}
await prisma.$disconnect();
process.exit(0);
