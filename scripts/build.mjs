import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';

const root = resolve(import.meta.dirname, '..');
const read = file => readFile(resolve(root, file), 'utf8');
const [core, html, css, js, cli, integration, emSkill] = await Promise.all([
 read('src/app.mjs'), read('src/ui.html'), read('src/ui.css'), read('src/ui.js'), read('relay.py'), read('INTEGRATION.md'), read('EM_SKILL.md')
]);
// Everything ships compressed, the room's JavaScript included: the function's source
// travels inside one process argument, and the plain core alone was within 2 KiB of
// that limit by 2026-10-08. At start the core is written to a temporary file and
// imported, so stack traces still point at real lines of app.mjs.
const embedded = {core, html, css, js, cli, integration, emSkill};
const packedAssets = brotliCompressSync(Buffer.from(JSON.stringify(embedded)), {params:{[constants.BROTLI_PARAM_QUALITY]:11}}).toString('base64');
if (JSON.stringify(JSON.parse(brotliDecompressSync(Buffer.from(packedAssets,'base64')).toString('utf8'))) !== JSON.stringify(embedded)) {
 throw new Error('Asset compression integrity check failed.');
}
const prelude = `
import { brotliDecompressSync } from 'node:zlib';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const { core, ...assets } = JSON.parse(brotliDecompressSync(Buffer.from('${packedAssets}', 'base64')).toString('utf8'));
const corePath = join(mkdtempSync(join(tmpdir(), 'ichosethis-')), 'app.mjs');
writeFileSync(corePath, core);
const { createApp } = await import(corePath);
const hash = value => createHash('sha256').update(value).digest('hex');
`;
const runtime = `
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
const appOrigin = Bun.env.APP_ORIGIN || (Bun.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + Bun.env.RAILWAY_PUBLIC_DOMAIN : '');
const accessCode = Bun.env.OWNER_ACCESS_CODE;
if (!accessCode || accessCode.length < 24) throw new Error('Configure a random OWNER_ACCESS_CODE before deploying.');
// Railway attaches the persistent /data volume before this service starts.
const databasePath = Bun.env.DATABASE_PATH || '/data/relay.sqlite';
if (!databasePath.startsWith('/data/')) throw new Error('Production history must use the persistent /data volume.');
mkdirSync('/data', {recursive: true});
const database = new Database(databasePath, {create: true});
const emailKey = Bun.env.DOORBELL_EMAIL_KEY, emailFrom = Bun.env.DOORBELL_FROM, emailTo = Bun.env.DOORBELL_TO;
const doorbell = emailKey && emailFrom && emailTo ? async ({seq,origin}) => {
 const delivery = await fetch('https://api.resend.com/emails', {method:'POST',signal:AbortSignal.timeout(9000),headers:{Authorization:'Bearer '+emailKey,'Content-Type':'application/json','Idempotency-Key':'ichosethis-'+hash(origin).slice(0,16)+'-'+seq},body:JSON.stringify({from:emailFrom,to:[emailTo],subject:'[IChoseThis] Doorbell '+seq,text:'A new room message is ready.\\nRoom: IChoseThis\\nSequence: '+seq+'\\nOpen the authenticated IChoseThis plugin to read your inbox.\\n'+origin+'\\nThis notification contains no room message text or pictures.'})});
 if (!delivery.ok) throw new Error('delivery_failed');
} : null;
const app = appOrigin.startsWith('https://') ? createApp({db: database, origin: appOrigin, ownerCode: accessCode, doorbell, ...assets}) : null;
if (app) void app.flushDoorbells().catch(()=>{});
// Railway requires a live service instance before it can allocate a domain.
// During that provisioning step no room data or sign-in is exposed.
export default {port: Number(Bun.env.PORT || 3000), fetch: app ? app.fetch : (request) => new Response(JSON.stringify({status:'waiting_for_domain'}), {status:new URL(request.url).pathname === '/health' ? 200 : 503, headers:{'Content-Type':'application/json','Cache-Control':'no-store'}})};
`;
await mkdir(resolve(root,'dist'), {recursive:true});
const output = prelude + runtime;
// Railway's function launcher passes base64 source as one Linux process argument.
// Keep it below the per-argument limit, including encoding and launcher overhead.
// Reserve eight KiB for the launcher's shell wrapper beneath Linux's 128 KiB
// single-argument limit, measured after base64 encoding rather than by chars.
const encoded = Buffer.from(output).toString('base64').length;
if (encoded + 8192 > 131072) throw new Error('Railway function exceeds the safe launcher limit.');
await writeFile(resolve(root,'dist/railway-function.ts'), output);
console.log('Built complete Railway function with losslessly compressed core and assets (' + Buffer.byteLength(output) + ' bytes, ' + encoded + ' of ' + (131072-8192) + ' encoded characters).');
