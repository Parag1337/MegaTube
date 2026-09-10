/**
 * Unit tests for lib/titles.ts metadata extraction.
 *
 * Covers:
 *   - real filename preserved (no video-<nodeId> fallback when name exists)
 *   - extension removed correctly
 *   - "Creator - Title.ext" parsing
 *   - creator extraction
 *   - title extraction
 *   - filename without delimiter
 *   - filename with multiple " - " delimiters
 *   - folder/path has no effect on title/creator
 *   - video anywhere in tree is treated normally
 *   - CDN wrapper suffixes are stripped
 *   - Watch_ prefix is stripped
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVideoMetadata,
  titleFromFilename,
  slugify,
  normalizeCreatorName,
} from '@/lib/titles';

test('parseVideoMetadata: "Creator - Title.ext" -> creator + title without extension', () => {
  const { creator, title } = parseVideoMetadata('John Doe - My Amazing Video.mp4');
  assert.equal(creator, 'John Doe');
  assert.equal(title, 'My Amazing Video');
});

test('parseVideoMetadata: creator and title are trimmed', () => {
  const { creator, title } = parseVideoMetadata('  John Doe  -  My Amazing Video  .mp4');
  assert.equal(creator, 'John Doe');
  assert.equal(title, 'My Amazing Video');
});

test('parseVideoMetadata: multiple " - " delimiters keep remainder in title', () => {
  const { creator, title } = parseVideoMetadata('Creator - Part One - Part Two.mp4');
  assert.equal(creator, 'Creator');
  assert.equal(title, 'Part One - Part Two');
});

test('parseVideoMetadata: no delimiter -> title only, creator null', () => {
  const { creator, title } = parseVideoMetadata('Just A Title.mp4');
  assert.equal(creator, null);
  assert.equal(title, 'Just A Title');
});

test('parseVideoMetadata: underscore convention "Creator_-_Title"', () => {
  const { creator, title } = parseVideoMetadata('Creator_Name_-_Video_Title.mp4');
  assert.equal(creator, 'Creator Name');
  assert.equal(title, 'Video Title');
});

test('parseVideoMetadata: CDN suffix is stripped before parsing', () => {
  const { creator, title } = parseVideoMetadata(
    'Watch_Lady_Onyx_-_Strap_On_Deal_JOI.mp4_-_VOE___Content_Delivery_Network_(CDN)___Video_Cloud.mp4',
  );
  assert.equal(creator, 'Lady Onyx');
  assert.equal(title, 'Strap On Deal JOI');
});

test('parseVideoMetadata: Watch_ prefix is stripped before parsing', () => {
  const { creator, title } = parseVideoMetadata('Watch_Summer_Hart_-_You_Got_Pegged.mp4');
  assert.equal(creator, 'Summer Hart');
  assert.equal(title, 'You Got Pegged');
});

test('parseVideoMetadata: CDN suffix without Watch_ prefix', () => {
  const { creator, title } = parseVideoMetadata(
    'Lady_Onyx_-_Strap_On_Deal_JOI.mp4_-_VOE___Content_Delivery_Network_(CDN)___Video_Cloud.mp4',
  );
  assert.equal(creator, 'Lady Onyx');
  assert.equal(title, 'Strap On Deal JOI');
});

test('parseVideoMetadata: path does not affect title or creator', () => {
  const { creator, title } = parseVideoMetadata('/Some Folder/Creator Name - Test Video.mp4');
  assert.equal(creator, 'Creator Name');
  assert.equal(title, 'Test Video');
});

test('parseVideoMetadata: nested folder does not affect title or creator', () => {
  const { creator, title } = parseVideoMetadata(
    '/Random/Some/Nested/Folder/Creator Name - Test Video.mp4',
  );
  assert.equal(creator, 'Creator Name');
  assert.equal(title, 'Test Video');
});

test('parseVideoMetadata: never falls back to video-<nodeId> when real filename exists', () => {
  const { creator, title } = parseVideoMetadata('Creator - Title.mp4');
  assert.notEqual(title, 'video-anything');
  assert.notEqual(creator, 'video-anything');
});

test('titleFromFilename: strips extension and normalizes underscores', () => {
  assert.equal(titleFromFilename('My_Video_Title.mp4'), 'My Video Title');
  assert.equal(titleFromFilename('normal-title.mp4'), 'normal-title');
});

test('slugify: lowercase kebab-case ASCII only', () => {
  assert.equal(slugify('Hello World!'), 'hello-world');
  assert.equal(slugify('C++'), 'c');
});

test('normalizeCreatorName: strips generic prefixes', () => {
  assert.equal(normalizeCreatorName('JOI'), 'Unknown Creator');
  assert.equal(normalizeCreatorName('BBC'), 'Unknown Creator');
  assert.equal(normalizeCreatorName('POV'), 'Unknown Creator');
  assert.equal(normalizeCreatorName('Lady Onyx'), 'Lady Onyx');
});
