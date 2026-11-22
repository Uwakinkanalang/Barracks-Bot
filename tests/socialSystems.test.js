import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sendFriendRequest, resolveFriendRequest, removeFriend, getFriendshipPoints,
  claimFriendshipDailyBonus, awardFriendshipPoints, createSoulmateRequest,
  resolveSoulmateRequest, validateMarriageEligibility, getActiveSoulmate,
  endSoulmate, blockFriendshipMember, expireFriendshipRequests,
} from '../src/services/friendshipService.js';

function makeClient() {
  const store = new Map();
  return {
    db: {
      async get(key, fallback = null) {
        return store.has(key) ? structuredClone(store.get(key)) : fallback;
      },
      async set(key, value) {
        store.set(key, structuredClone(value));
        return true;
      },
    },
  };
}

const guildId = '100000000000000001';
const memberA = '200000000000000001';
const memberB = '200000000000000002';
const DAY = 24 * 60 * 60 * 1000;

test('friendship history, point cap, Soulmate eligibility, and block controls', async () => {
  const client = makeClient();
  const sent = await sendFriendRequest(client, guildId, memberA, memberB);
  assert.equal(sent.status, 'created');

  const accepted = await resolveFriendRequest(client, guildId, sent.request.id, memberB, 'accepted');
  assert.equal(accepted.status, 'accepted');

  const start = Date.UTC(2026, 0, 1);
  const daily = await claimFriendshipDailyBonus(client, guildId, memberA, memberB, start);
  assert.equal(daily.status, 'claimed');
  assert.equal(daily.points, 5);

  const capped = await awardFriendshipPoints(client, guildId, memberA, memberB, 30, {
    now: start, activityKey: 'cap-check',
  });
  assert.equal(capped.points, 25);
  assert.equal(capped.remainingToday, 0);

  for (let day = 1; day < 34; day++) {
    const result = await awardFriendshipPoints(client, guildId, memberA, memberB, 30, {
      now: start + day * DAY, activityKey: 'daily-' + day,
    });
    assert.equal(result.points, 30);
  }

  const soulmateRequest = await createSoulmateRequest(client, guildId, memberA, memberB);
  assert.equal(soulmateRequest.status, 'created');
  const soulmateAccepted = await resolveSoulmateRequest(client, guildId, soulmateRequest.request.id, memberB, 'accepted');
  assert.equal(soulmateAccepted.status, 'accepted');
  assert.ok(await getActiveSoulmate(client, guildId, memberA));

  const eligibility = await validateMarriageEligibility(client, guildId, memberA, memberB);
  assert.equal(eligibility.eligible, true);
  assert.ok(eligibility.points >= 1000);

  const beforeRemoval = await getFriendshipPoints(client, guildId, memberA, memberB);
  const removed = await removeFriend(client, guildId, memberA, memberB);
  assert.equal(removed.status, 'removed');
  assert.equal(await getFriendshipPoints(client, guildId, memberA, memberB), beforeRemoval);

  const restoredRequest = await sendFriendRequest(client, guildId, memberB, memberA);
  assert.equal(restoredRequest.status, 'created');
  const restored = await resolveFriendRequest(client, guildId, restoredRequest.request.id, memberA, 'accepted');
  assert.equal(restored.status, 'accepted');
  assert.equal(restored.friendship.points, beforeRemoval);
  assert.equal(restored.friendship.createdAt, accepted.friendship.createdAt);

  const ended = await endSoulmate(client, guildId, memberA);
  assert.equal(ended.status, 'ended');
  const cooldownBlocked = await createSoulmateRequest(client, guildId, memberA, memberB);
  assert.equal(cooldownBlocked.status, 'cooldown');

  await blockFriendshipMember(client, guildId, memberA, memberB);
  const blockedAward = await awardFriendshipPoints(client, guildId, memberA, memberB, 1, {
    now: start + 35 * DAY, activityKey: 'blocked',
  });
  assert.equal(blockedAward.status, 'blocked');
});

test('friendship requests expire automatically after their seven-day window', async () => {
  const client = makeClient();
  const now = Date.UTC(2026, 2, 1);
  const sent = await sendFriendRequest(client, guildId, memberA, memberB);
  assert.equal(sent.status, 'created');
  const expired = await expireFriendshipRequests(client, guildId, now + 8 * DAY);
  assert.equal(expired, 1);
  const retry = await sendFriendRequest(client, guildId, memberA, memberB);
  assert.equal(retry.status, 'created');
});
