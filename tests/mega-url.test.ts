import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMegaUrl,
  isMegaFileUrl,
  validateMegaUrl,
  generateEmbedUrl,
  tryGenerateEmbedUrl,
  megaFileUrlToEmbedUrl,
  megaFileUrlToPreviewUrl,
  tryMegaFileUrlToPreviewUrl,
} from '../lib/mega';

const SAMPLE =
  'https://mega.nz/file/20oTQTBS#Es81h54-mAexuTyLFjq63tXmm6Nn99dmjkSGEgaxdFk';

test('parses a standard MEGA public file link', () => {
  const parsed = parseMegaUrl(SAMPLE);
  assert.equal(parsed.megaFileId, '20oTQTBS');
  assert.equal(
    parsed.megaFileKey,
    'Es81h54-mAexuTyLFjq63tXmm6Nn99dmjkSGEgaxdFk',
  );
  assert.equal(parsed.url, SAMPLE);
});

test('trims surrounding whitespace', () => {
  const parsed = parseMegaUrl(`  ${SAMPLE}\n`);
  assert.equal(parsed.megaFileId, '20oTQTBS');
});

test('accepts mega.co.nz hosts', () => {
  const parsed = parseMegaUrl(SAMPLE.replace('mega.nz', 'mega.co.nz'));
  assert.equal(parsed.megaFileId, '20oTQTBS');
});

test('rejects unsupported formats', () => {
  const bad = [
    '',
    'https://mega.nz/file/20oTQTBS', // no key
    'https://mega.nz/folder/20oTQTBS#key', // folder link
    'https://mega.nz/file/12345#key', // id too short
    'https://mega.nz/file/20oTQTBS#aGVsbG8', // key too short
    'https://example.com/file/20oTQTBS#key',
    'https://mega.nz/#!20oTQTBS!key', // legacy format
    'not a url',
  ];
  for (const url of bad) {
    assert.equal(isMegaFileUrl(url), false, `expected rejection: ${url}`);
    assert.ok(validateMegaUrl(url), `expected validation error: ${url}`);
  }
});

test('generateEmbedUrl transforms file -> embed without touching the key', () => {
  assert.equal(
    generateEmbedUrl(SAMPLE),
    'https://mega.nz/embed/20oTQTBS#Es81h54-mAexuTyLFjq63tXmm6Nn99dmjkSGEgaxdFk',
  );
});

test('megaFileUrlToEmbedUrl adds !1a1m for autoplay+muted preview', () => {
  assert.equal(
    megaFileUrlToEmbedUrl(SAMPLE, { autoplay: true, muted: true }),
    'https://mega.nz/embed/20oTQTBS#Es81h54-mAexuTyLFjq63tXmm6Nn99dmjkSGEgaxdFk!1a1m',
  );
  assert.equal(
    megaFileUrlToPreviewUrl(SAMPLE),
    'https://mega.nz/embed/20oTQTBS#Es81h54-mAexuTyLFjq63tXmm6Nn99dmjkSGEgaxdFk!1a1m',
  );
});

test('autoplay only / muted only suffixes', () => {
  assert.equal(
    megaFileUrlToEmbedUrl(SAMPLE, { autoplay: true }),
    'https://mega.nz/embed/20oTQTBS#Es81h54-mAexuTyLFjq63tXmm6Nn99dmjkSGEgaxdFk!1a',
  );
  assert.equal(
    megaFileUrlToEmbedUrl(SAMPLE, { muted: true }),
    'https://mega.nz/embed/20oTQTBS#Es81h54-mAexuTyLFjq63tXmm6Nn99dmjkSGEgaxdFk!1m',
  );
  assert.equal(
    megaFileUrlToEmbedUrl(SAMPLE),
    'https://mega.nz/embed/20oTQTBS#Es81h54-mAexuTyLFjq63tXmm6Nn99dmjkSGEgaxdFk',
  );
});

test('keys with _ and - are preserved exactly', () => {
  const url = 'https://mega.nz/file/Kso1DIba#lvQjO_GZ-WhEi9SoaMQtQ0IcD9-D1wdPzaCGpwXCsFk';
  const parsed = parseMegaUrl(url);
  assert.equal(parsed.megaFileKey, 'lvQjO_GZ-WhEi9SoaMQtQ0IcD9-D1wdPzaCGpwXCsFk');
  assert.equal(
    megaFileUrlToPreviewUrl(url),
    'https://mega.nz/embed/Kso1DIba#lvQjO_GZ-WhEi9SoaMQtQ0IcD9-D1wdPzaCGpwXCsFk!1a1m',
  );
});

test('non-throwing embed helpers return null on malformed links', () => {
  const bad = [
    '',
    'https://mega.nz/file/20oTQTBS',
    'https://example.com/file/20oTQTBS#key',
    'not a url',
  ];
  for (const url of bad) {
    assert.equal(tryGenerateEmbedUrl(url), null, `tryGenerateEmbedUrl: ${url}`);
    assert.equal(tryMegaFileUrlToPreviewUrl(url), null, `tryMegaFileUrlToPreviewUrl: ${url}`);
  }
});

test('non-throwing embed helpers match throwing variants for valid links', () => {
  assert.equal(
    tryGenerateEmbedUrl(SAMPLE),
    generateEmbedUrl(SAMPLE),
  );
  assert.equal(
    tryMegaFileUrlToPreviewUrl(SAMPLE),
    megaFileUrlToPreviewUrl(SAMPLE),
  );
});

test('does not URL-decode or re-encode the key', () => {
  const parsed = parseMegaUrl(SAMPLE);
  const embed = megaFileUrlToEmbedUrl(SAMPLE, { autoplay: true, muted: true });
  assert.ok(embed.includes(parsed.megaFileKey));
  assert.equal(embed.split('#')[1], `${parsed.megaFileKey}!1a1m`);
});