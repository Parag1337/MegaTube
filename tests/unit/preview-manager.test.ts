/**
 * Phase 5.1: client preview coordinator.
 *
 * Desktop: at most one active preview. Mobile: only the most visible
 * candidate auto-plays and the previous one is stopped first.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetPreviewManagerForTests,
  acquirePreview,
  releasePreview,
  removeMobileCandidate,
  reportMobileVisibility,
} from '@/lib/preview-manager';

beforeEach(() => {
  __resetPreviewManagerForTests();
});

test('acquirePreview stops the previous preview (one at a time)', () => {
  let aStopped = 0;
  const stopA = () => {
    aStopped++;
  };
  acquirePreview(stopA);
  acquirePreview(() => {});
  assert.equal(aStopped, 1);

  // Re-acquiring the same stop function must not stop itself.
  acquirePreview(stopA);
  acquirePreview(stopA);
  assert.equal(aStopped, 1);
});

test('releasePreview only frees the slot for its owner', () => {
  let aStopped = 0;
  let bStopped = 0;
  const stopA = () => {
    aStopped++;
  };
  const stopB = () => {
    bStopped++;
  };
  acquirePreview(stopA);
  releasePreview(stopB); // not the owner
  acquirePreview(stopB);
  assert.equal(aStopped, 1);
  assert.equal(bStopped, 0);
});

test('mobile: below the visibility threshold never activates', () => {
  let activated = 0;
  reportMobileVisibility('card-1', 0.5, {
    activate: () => activated++,
    deactivate: () => {},
  });
  assert.equal(activated, 0);
});

test('mobile: the most prominent visible card is the only one playing', () => {
  const events: string[] = [];
  reportMobileVisibility('card-1', 0.65, {
    activate: () => events.push('activate-1'),
    deactivate: () => events.push('deactivate-1'),
  });
  reportMobileVisibility('card-2', 0.9, {
    activate: () => events.push('activate-2'),
    deactivate: () => events.push('deactivate-2'),
  });
  assert.deepEqual(events, ['activate-1', 'deactivate-1', 'activate-2']);
});

test('mobile: scrolling a card out hands playback to the next candidate', () => {
  const events: string[] = [];
  reportMobileVisibility('card-1', 0.9, {
    activate: () => events.push('activate-1'),
    deactivate: () => events.push('deactivate-1'),
  });
  reportMobileVisibility('card-2', 0.7, {
    activate: () => events.push('activate-2'),
    deactivate: () => events.push('deactivate-2'),
  });
  // card-1 wins on ratio; scrolling it out must stop it and start card-2.
  removeMobileCandidate('card-1');
  assert.deepEqual(events, ['activate-1', 'deactivate-1', 'activate-2']);
});

test('mobile: updating the same card does not restart its preview', () => {
  let activated = 0;
  const handlers = { activate: () => activated++, deactivate: () => {} };
  reportMobileVisibility('card-1', 0.7, handlers);
  reportMobileVisibility('card-1', 0.8, handlers);
  reportMobileVisibility('card-1', 1, handlers);
  assert.equal(activated, 1);
});

test('mobile: dropping below the threshold deactivates the active card', () => {
  let deactivated = 0;
  reportMobileVisibility('card-1', 0.8, {
    activate: () => {},
    deactivate: () => deactivated++,
  });
  reportMobileVisibility('card-1', 0.4, {
    activate: () => {},
    deactivate: () => deactivated++,
  });
  assert.equal(deactivated, 1);
});
