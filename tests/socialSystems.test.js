import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sendFriendRequest, resolveFriendRequest, removeFriend, getFriendshipPoints,
  claimFriendshipDailyBonus, awardFriendshipPoints, createSoulmateRequest,
  resolveSoulmateRequest, validateMarriageEligibility, getActiveSoulmate,
  endSoulmate, blockFriendshipMember, expireFriendshipRequests,
} from '../src/services/friendshipService.js';
import {
  createMarriageProposal, finalizeMarriageProposal, getActiveMarriage,
  divorceMarriage, getMarriageData, saveMarriageData, processMarriageAnniversaries,
} from '../src/services/marriageService.js';

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
  const sent = await sendFriendRequest(client, guildId, memberA, memberB);
  assert.equal(sent.status, 'created');
  const expired = await expireFriendshipRequests(client, guildId, Date.now() + 8 * DAY);
  assert.equal(expired, 1);
  const retry = await sendFriendRequest(client, guildId, memberA, memberB);
  assert.equal(retry.status, 'created');
});


test('marriage proposal fee, acceptance, divorce fee, and remarriage cooldown', async () => {
  const store = new Map();
  const client = {
    db: {
      async get(key, fallback = null) { return store.has(key) ? structuredClone(store.get(key)) : fallback; },
      async set(key, value) { store.set(key, structuredClone(value)); return true; },
    },
  };
  store.set('global:economy:' + memberA, { wallet: 200000, bank: 0 });
  const eligible = async () => ({ eligible: true, points: 1000 });
  const proposal = await createMarriageProposal(client, guildId, memberA, memberB, {
    validateEligibility: eligible,
  });
  assert.equal(proposal.status, 'created');
  assert.equal((await client.db.get('global:economy:' + memberA)).wallet, 100000);

  const finalized = await finalizeMarriageProposal(client, guildId, proposal.proposal.id, memberB, {
    validateEligibility: eligible,
  });
  assert.equal(finalized.status, 'married');
  assert.equal((await getActiveMarriage(client, guildId, memberA)).spouseId, memberB);

  const divorced = await divorceMarriage(client, guildId, memberA, { confirmed: true });
  assert.equal(divorced.status, 'divorced');
  assert.equal(divorced.fee, 100000);
  assert.equal((await client.db.get('global:economy:' + memberA)).wallet, 0);
  assert.equal(await getActiveMarriage(client, guildId, memberA), null);

  const blockedRemarriage = await createMarriageProposal(client, guildId, memberA, memberB, {
    validateEligibility: eligible,
  });
  assert.equal(blockedRemarriage.status, 'remarriage_cooldown');
});

test('yearly marriage anniversary rewards are paid once per spouse and anniversary', async () => {
  const store = new Map();
  const client = {
    db: {
      async get(key, fallback = null) { return store.has(key) ? structuredClone(store.get(key)) : fallback; },
      async set(key, value) { store.set(key, structuredClone(value)); return true; },
    },
  };
  const spouseA = '200000000000000003';
  const spouseB = '200000000000000004';
  store.set('global:economy:' + spouseA, { wallet: 0, bank: 0 });
  store.set('global:economy:' + spouseB, { wallet: 0, bank: 0 });
  const weddingDate = new Date();
  weddingDate.setUTCFullYear(weddingDate.getUTCFullYear() - 2);
  const marriedAt = weddingDate.getTime();
  await saveMarriageData(client, guildId, {
    proposals: {}, history: [], transactions: {}, anniversaryClaims: {}, divorceCooldowns: {},
    marriages: {
      'anniversary-test': {
        id: 'anniversary-test', member1Id: spouseA, member2Id: spouseB,
        status: 'married', marriedAt, anniversaryRewards: { [spouseA]: 0, [spouseB]: 0 },
      },
    },
  });

  const firstRun = await processMarriageAnniversaries(client, guildId);
  assert.equal(firstRun.length, 2);
  assert.equal((await client.db.get('global:economy:' + spouseA)).wallet, 2000000);
  assert.equal((await client.db.get('global:economy:' + spouseB)).wallet, 2000000);

  const secondRun = await processMarriageAnniversaries(client, guildId);
  assert.equal(secondRun.length, 0);
  assert.equal((await client.db.get('global:economy:' + spouseA)).wallet, 2000000);
  assert.equal((await client.db.get('global:economy:' + spouseB)).wallet, 2000000);
});
