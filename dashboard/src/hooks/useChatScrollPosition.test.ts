import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideRestoreTarget, grewAboveReadingPosition, isNearBottom } from './useChatScrollPosition.ts';

test('isNearBottom: exactly at the bottom counts as near', () => {
  assert.equal(isNearBottom(1000, 2000, 1000), true); // 2000-1000-1000 = 0
});

test('isNearBottom: within the 24px tolerance counts as near', () => {
  assert.equal(isNearBottom(980, 2000, 1000), true); // 20px above bottom
});

test('isNearBottom: beyond the tolerance does not count', () => {
  assert.equal(isNearBottom(500, 2000, 1000), false); // 500px above bottom
});

test('isNearBottom: a scrolled-to-top container is not near the bottom', () => {
  assert.equal(isNearBottom(0, 20000, 800), false);
});

test('first render with no saved position: restore to bottom when loaded', () => {
  assert.deepEqual(decideRestoreTarget('A', true, undefined), { restore: 'bottom' });
});

test('first render still loading: no restore', () => {
  assert.deepEqual(decideRestoreTarget('A', false, undefined), { restore: null });
});

test('cold open: loading transition then loaded → restore to bottom', () => {
  assert.deepEqual(decideRestoreTarget('A', false, undefined), { restore: null });
  assert.deepEqual(decideRestoreTarget('A', true, undefined), { restore: 'bottom' });
});

test('returning to a chat with a saved position restores it (never bottom-jumps)', () => {
  // The scroll listener saves the live scrollTop continuously, so a round trip A → B → A finds A's
  // real last position in the map and restores it exactly.
  assert.deepEqual(decideRestoreTarget('A', true, 250), { restore: 'saved' });
});

test('a saved position of 0 is still a saved position (top of thread is a real place)', () => {
  assert.deepEqual(decideRestoreTarget('A', true, 0), { restore: 'saved' });
});

test('deselect chat (next is null): no restore', () => {
  assert.deepEqual(decideRestoreTarget(null, false, undefined), { restore: null });
});

// The container's top edge is the reading position: everything above it is scrolled out of view.
const CONTAINER_TOP = 100;

test('media entirely above the reading position displaced the view, so it is corrected', () => {
  // Bottom edge at 40, well clear of the container's top at 100.
  assert.equal(grewAboveReadingPosition(40, CONTAINER_TOP), true);
});

test('media whose bottom edge sits exactly on the top edge still counts as above', () => {
  assert.equal(grewAboveReadingPosition(CONTAINER_TOP, CONTAINER_TOP), true);
});

test('media below the reading position moved nothing on screen and is left alone', () => {
  // This is the case a bare scrollHeight delta got wrong: correcting here scrolls the reader
  // toward the newest messages by the decoded height, which is the opposite of holding position.
  assert.equal(grewAboveReadingPosition(450, CONTAINER_TOP), false);
});

test('media straddling the top edge is left uncorrected rather than over-corrected', () => {
  // Top above the edge, bottom below it: only the part above displaces, so a full correction
  // would overshoot. Answering false drifts with the reader rather than against them.
  assert.equal(grewAboveReadingPosition(160, CONTAINER_TOP), false);
});
