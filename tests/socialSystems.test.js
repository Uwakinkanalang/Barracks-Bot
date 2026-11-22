import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sendFriendRequest, resolveFriendRequest, cancelFriendRequest, removeFriend, getFriendshipPoints,
  claimFriendshipDailyBonus, awardFriendshipPoints, createSoulmateRequest,
  resolveSoulmateRequest, validateMarriageEligibility, getActiveSoulmate,
  endSoulmate, blockFriendshipMember, expireFriendshipRequests,
} from '../src/services/friendshipService.js';
import {
  createMarriageProposal, finalizeMarriageProposal, cancelMarriageProposal, getActiveMarriage,
  divorceMarriage, saveMarriageData, processMarriageAnniversaries, processMarriageNotifications,
} from '../src/services/marriageService.js';
import { withEconomyTransaction, startEconomyWager, settleEconomyWager, listPendingEconomyWagers, recoverEconomyWager } from '../src/utils/economy.js';

function addTestTransaction(db, store) {
  db.withKeyValueTransaction = async (callback) => {
    const snapshot = new Map([...store.entries()].map(([key, value]) => [key, structuredClone(value)]));
    const transaction = {
      get: db.get.bind(db),
      set: async (key, value) => {
        return db.set(key, value);
      },
    };
    try {
      return await callback(transaction);
    } catch (error) {
      store.clear();
      for (const [key, value] of snapshot) store.set(key, value);
      throw error;
    }
  };
  return db;
}

function makeClient() {
  const store = new Map();
  const db = {
    async get(key, fallback = null) {
      return store.has(key) ? structuredClone(store.get(key)) : fallback;
    },
    async set(key, value) {
      store.set(key, structuredClone(value));
      return true;
    },
    async list(prefix) {
      return [...store.keys()].filter((key) => key.startsWith(prefix));
    },
  };
  addTestTransaction(db, store);
  return { db };
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

test('Friendship daily cap resets at Manila midnight, not UTC midnight', async () => {
  const client = makeClient();
  const sent = await sendFriendRequest(client, guildId, memberA, memberB);
  await resolveFriendRequest(client, guildId, sent.request.id, memberB, 'accepted');

  // 15:59 UTC is 23:59 in Manila; one minute later is the next Manila day.
  const beforeMidnight = Date.UTC(2026, 0, 1, 15, 59);
  const firstDay = await awardFriendshipPoints(client, guildId, memberA, memberB, 30, {
    now: beforeMidnight, activityKey: 'manila-day-one',
  });
  const nextDay = await awardFriendshipPoints(client, guildId, memberA, memberB, 30, {
    now: beforeMidnight + 60_000, activityKey: 'manila-day-two',
  });

  assert.equal(firstDay.points, 30);
  assert.equal(nextDay.points, 30);
  assert.equal(nextDay.remainingToday, 0);
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
  addTestTransaction(client.db, store);
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

test('concurrent marriage proposals cannot double-charge or create duplicates', async () => {
  const client = makeClient();
  await client.db.set('global:economy:' + memberA, { wallet: 250000, bank: 0 });
  const eligible = async () => ({ eligible: true, points: 1000 });
  const results = await Promise.all([
    createMarriageProposal(client, guildId, memberA, memberB, { validateEligibility: eligible }),
    createMarriageProposal(client, guildId, memberA, memberB, { validateEligibility: eligible }),
  ]);
  assert.equal(results.filter(result => result.status === 'created').length, 1);
  assert.equal(results.filter(result => result.status === 'duplicate_pending').length, 1);
  assert.equal((await client.db.get('global:economy:' + memberA)).wallet, 150000);
});

test('concurrent acceptance can finalize a marriage only once', async () => {
  const client = makeClient();
  await client.db.set('global:economy:' + memberA, { wallet: 200000, bank: 0 });
  const eligible = async () => ({ eligible: true, points: 1000 });
  const proposal = await createMarriageProposal(client, guildId, memberA, memberB, {
    validateEligibility: eligible,
  });
  const results = await Promise.all([
    finalizeMarriageProposal(client, guildId, proposal.proposal.id, memberB, { validateEligibility: eligible }),
    finalizeMarriageProposal(client, guildId, proposal.proposal.id, memberB, { validateEligibility: eligible }),
  ]);
  assert.equal(results.filter(result => result.status === 'married').length, 1);
  assert.equal(results.filter(result => result.status === 'not_pending').length, 1);
  assert.equal((await getActiveMarriage(client, guildId, memberA)).spouseId, memberB);
});

test('relationship actions reject unauthorized members and unconfirmed divorce', async () => {
  const client = makeClient();

  const friendRequest = await sendFriendRequest(client, guildId, memberA, memberB);
  assert.equal(friendRequest.status, 'created');
  assert.equal(
    (await resolveFriendRequest(client, guildId, friendRequest.request.id, memberA, 'accepted')).status,
    'not_authorized',
  );
  assert.equal(
    (await cancelFriendRequest(client, guildId, friendRequest.request.id, memberB)).status,
    'not_authorized',
  );
  assert.equal(
    (await resolveFriendRequest(client, guildId, friendRequest.request.id, memberB, 'accepted')).status,
    'accepted',
  );

  await client.db.set('global:economy:' + memberA, { wallet: 200000, bank: 0 });
  const eligible = async () => ({ eligible: true, points: 1000 });
  const proposal = await createMarriageProposal(client, guildId, memberA, memberB, {
    validateEligibility: eligible,
  });
  assert.equal(proposal.status, 'created');
  assert.equal(
    (await finalizeMarriageProposal(client, guildId, proposal.proposal.id, memberA, { validateEligibility: eligible })).status,
    'not_authorized',
  );
  assert.equal(
    (await cancelMarriageProposal(client, guildId, proposal.proposal.id, memberB)).status,
    'not_authorized',
  );
  assert.equal((await client.db.get('global:economy:' + memberA)).wallet, 100000);

  const married = await finalizeMarriageProposal(client, guildId, proposal.proposal.id, memberB, {
    validateEligibility: eligible,
  });
  assert.equal(married.status, 'married');
  assert.equal((await divorceMarriage(client, guildId, memberA)).status, 'confirmation_required');
  assert.equal((await client.db.get('global:economy:' + memberA)).wallet, 100000);
});

test('yearly marriage anniversary rewards are paid once per spouse and anniversary', async () => {
  const store = new Map();
  const client = {
    db: {
      async get(key, fallback = null) { return store.has(key) ? structuredClone(store.get(key)) : fallback; },
      async set(key, value) { store.set(key, structuredClone(value)); return true; },
    },
  };
  addTestTransaction(client.db, store);
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


test('marriage fees and anniversary rewards fail closed when PostgreSQL is degraded', async () => {
  const store = new Map();
  const client = {
    db: {
      isAvailable() { return false; },
      async get(key, fallback = null) { return store.has(key) ? structuredClone(store.get(key)) : fallback; },
      async set(key, value) { store.set(key, structuredClone(value)); return true; },
    },
  };
  const economyKey = 'global:economy:' + memberA;
  store.set(economyKey, { wallet: 250000, bank: 0 });
  const eligible = async () => ({ eligible: true, points: 1000 });

  const proposal = await createMarriageProposal(client, guildId, memberA, memberB, {
    validateEligibility: eligible,
  });
  assert.equal(proposal.status, 'database_unavailable');
  assert.equal((await client.db.get(economyKey)).wallet, 250000);

  await saveMarriageData(client, guildId, {
    proposals: {}, history: [], transactions: {}, anniversaryClaims: {},
    divorceCooldowns: {},
    marriages: {
      'degraded-test': {
        id: 'degraded-test', member1Id: memberA, member2Id: memberB,
        status: 'married', marriedAt: Date.now() - (370 * DAY),
        anniversaryRewards: { [memberA]: 0, [memberB]: 0 },
      },
    },
  });
  const divorce = await divorceMarriage(client, guildId, memberA, { confirmed: true });
  assert.equal(divorce.status, 'database_unavailable');
  assert.equal((await client.db.get(economyKey)).wallet, 250000);

  const anniversaryPayments = await processMarriageAnniversaries(client, guildId);
  assert.equal(anniversaryPayments.length, 0);
  assert.equal((await client.db.get(economyKey)).wallet, 250000);
});


test('failed marriage-record persistence rolls back a successful proposal fee write', async () => {
  const store = new Map();
  let failMarriageWrite = true;
  const client = {
    db: {
      isAvailable() { return true; },
      async get(key, fallback = null) {
        return store.has(key) ? structuredClone(store.get(key)) : fallback;
      },
      async set(key, value) {
        if (key.endsWith(':marriage_system') && failMarriageWrite) {
          failMarriageWrite = false;
          return false;
        }
        store.set(key, structuredClone(value));
        return true;
      },
    },
  };
  addTestTransaction(client.db, store);
  const economyKey = 'global:economy:' + memberA;
  store.set(economyKey, { wallet: 250000, bank: 0 });
  const eligible = async () => ({ eligible: true, points: 1000 });

  await assert.rejects(
    createMarriageProposal(client, guildId, memberA, memberB, { validateEligibility: eligible }),
    /Marriage data could not be saved/,
  );
  const wallet = await client.db.get(economyKey);
  assert.equal(wallet.wallet, 250000);
  const marriageData = await client.db.get('guild:' + guildId + ':marriage_system');
  assert.equal(marriageData, null);
});


test('proposal aborts cleanly when the wallet debit write fails', async () => {
  const store = new Map();
  const economyKey = 'global:economy:' + memberA;
  store.set(economyKey, { wallet: 250000, bank: 0 });
  const client = {
    db: {
      isAvailable() { return true; },
      async get(key, fallback = null) {
        return store.has(key) ? structuredClone(store.get(key)) : fallback;
      },
      async set(key, value) {
        if (key === economyKey) return false;
        store.set(key, structuredClone(value));
        return true;
      },
    },
  };
  addTestTransaction(client.db, store);

  const proposal = await createMarriageProposal(client, guildId, memberA, memberB, {
    validateEligibility: async () => ({ eligible: true, points: 1000 }),
  });
  assert.equal(proposal.status, 'payment_failed');
  assert.equal((await client.db.get(economyKey)).wallet, 250000);
  assert.equal(await client.db.get('guild:' + guildId + ':marriage_system'), null);
});

test('failed divorce-record persistence restores the initiator wallet and keeps marriage active', async () => {
  const store = new Map();
  let failMarriageWrite = false;
  const client = {
    db: {
      isAvailable() { return true; },
      async get(key, fallback = null) {
        return store.has(key) ? structuredClone(store.get(key)) : fallback;
      },
      async set(key, value) {
        if (key.endsWith(':marriage_system') && failMarriageWrite) {
          failMarriageWrite = false;
          return false;
        }
        store.set(key, structuredClone(value));
        return true;
      },
    },
  };
  addTestTransaction(client.db, store);
  const economyKey = 'global:economy:' + memberA;
  store.set(economyKey, { wallet: 250000, bank: 0 });
  await saveMarriageData(client, guildId, {
    proposals: {}, history: [], transactions: {}, anniversaryClaims: {},
    divorceCooldowns: {},
    marriages: {
      'divorce-rollback-test': {
        id: 'divorce-rollback-test', member1Id: memberA, member2Id: memberB,
        status: 'married', marriedAt: Date.now() - DAY,
      },
    },
  });

  failMarriageWrite = true;
  await assert.rejects(
    divorceMarriage(client, guildId, memberA, { confirmed: true }),
    /Marriage data could not be saved/,
  );
  assert.equal((await client.db.get(economyKey)).wallet, 250000);
  const marriageData = await client.db.get('guild:' + guildId + ':marriage_system');
  assert.equal(marriageData.marriages['divorce-rollback-test'].status, 'married');
});


test('marriage notification outbox retries failures and marks successful delivery', async () => {
  const client = makeClient();
  const sent = [];
  let shouldFail = true;
  client.channels = {
    async fetch(channelId) {
      return {
        id: channelId,
        isTextBased: () => true,
        async send(payload) {
          if (shouldFail) throw new Error('Discord temporarily unavailable');
          sent.push(payload);
          return { id: 'message-1' };
        },
      };
    },
  };
  await saveMarriageData(client, guildId, {
    proposals: {}, marriages: {}, history: [], transactions: {},
    anniversaryClaims: {}, divorceCooldowns: {},
    notifications: {
      'notice-1': {
        id: 'notice-1', channelId: '300000000000000001',
        content: 'A Barracks marriage notice.',
        components: [], status: 'pending', attempts: 0,
        createdAt: 100, nextAttemptAt: 100,
      },
    },
  });

  const failed = await processMarriageNotifications(client, guildId, 100);
  assert.equal(failed.status, 'retry_scheduled');
  let data = await client.db.get('guild:' + guildId + ':marriage_system');
  assert.equal(data.notifications['notice-1'].status, 'pending');
  assert.equal(data.notifications['notice-1'].attempts, 1);
  assert.ok(data.notifications['notice-1'].nextAttemptAt > 100);

  shouldFail = false;
  const delivered = await processMarriageNotifications(client, guildId, Date.now() + 2 * 60 * 60 * 1000);
  assert.equal(delivered.status, 'delivered');
  assert.equal(sent.length, 1);
  data = await client.db.get('guild:' + guildId + ':marriage_system');
  assert.equal(data.notifications['notice-1'].status, 'delivered');
});


test('economy account transactions preserve concurrent marriage wallet updates', async () => {
  const client = makeClient();
  const userId = '400000000000000001';
  const economyKey = 'global:economy:' + userId;
  const starting = {
    wallet: 200000, bank: 0, lastDaily: 0,
    inventory: {}, cooldowns: {}, upgrades: {},
  };
  await client.db.set(economyKey, starting);

  const result = await withEconomyTransaction(client, guildId, userId, async (accounts) => {
    accounts[userId].wallet -= 100000;
    return accounts[userId].wallet;
  });
  assert.equal(result, 100000);
  assert.equal((await client.db.get(economyKey)).wallet, 100000);

  await assert.rejects(
    withEconomyTransaction(client, guildId, userId, async (accounts) => {
      accounts[userId].wallet -= 1000000;
      throw new Error('simulated operation failure');
    }),
    /simulated operation failure/,
  );
  assert.equal((await client.db.get(economyKey)).wallet, 100000);
});


test('memory fallback serializes same-account economy updates', async () => {
  const client = makeClient();
  client.db.isDegraded = () => true;
  const userId = '400000000000000002';
  const key = 'global:economy:' + userId;
  await client.db.set(key, { wallet: 0, bank: 0, inventory: {}, cooldowns: {} });

  await Promise.all([1, 2].map(() => withEconomyTransaction(client, guildId, userId, async (accounts) => {
    const current = Number(accounts[userId].wallet) || 0;
    await new Promise((resolve) => setTimeout(resolve, 5));
    accounts[userId].wallet = current + 1;
  })));

  assert.equal((await client.db.get(key)).wallet, 2);
});


test('economy game wagers reserve funds and settle exactly once', async () => {
  const client = makeClient();
  const userId = '400000000000000003';
  const key = 'global:economy:' + userId;
  await client.db.set(key, { wallet: 1000, bank: 0, inventory: {}, cooldowns: {} });

  const started = await startEconomyWager(client, guildId, userId, 'game-1', 200);
  assert.equal(started.started, true);
  assert.equal(started.wallet, 800);
  assert.equal((await startEconomyWager(client, guildId, userId, 'game-1', 200)).started, false);
  assert.equal((await client.db.get(key)).wallet, 800);

  const settled = await settleEconomyWager(client, guildId, userId, 'game-1', 400);
  assert.equal(settled.settled, true);
  assert.equal(settled.wallet, 1200);

  const duplicate = await settleEconomyWager(client, guildId, userId, 'game-1', 400);
  assert.equal(duplicate.settled, false);
  assert.equal(duplicate.wallet, 1200);
  assert.equal((await client.db.get(key)).wallet, 1200);
});


test('pending wagers can be listed and recovered exactly once with staff audit details', async () => {
  const client = makeClient();
  const userId = '400000000000000004';
  const key = 'global:economy:' + userId;
  await client.db.set(key, { wallet: 800, bank: 0, inventory: {}, cooldowns: {} });
  await startEconomyWager(client, guildId, userId, 'abandoned-game-1', 200);

  const pending = await listPendingEconomyWagers(client, guildId);
  assert.equal(pending.status, 'ok');
  assert.equal((await listPendingEconomyWagers(client, 'another-guild')).total, 0);
  assert.equal(pending.total, 1);
  assert.equal(pending.wagers[0].userId, userId);
  assert.equal(pending.wagers[0].gameId, 'abandoned-game-1');
  assert.equal(pending.wagers[0].amount, 200);

  const refunded = await recoverEconomyWager(client, guildId, userId, 'abandoned-game-1', {
    action: 'refund', actorId: '500000000000000001', reason: 'Game session was abandoned.',
  });
  assert.equal(refunded.recovered, true);
  assert.equal(refunded.status, 'refunded');
  assert.equal((await client.db.get(key)).wallet, 800);

  const duplicate = await recoverEconomyWager(client, guildId, userId, 'abandoned-game-1', {
    action: 'refund', actorId: '500000000000000001', reason: 'Duplicate recovery attempt.',
  });
  assert.equal(duplicate.recovered, false);
  assert.equal(duplicate.status, 'already_resolved');
  assert.equal((await client.db.get(key)).wallet, 800);
  const receipt = (await client.db.get(key)).economyGameTransactions['abandoned-game-1'];
  assert.equal(receipt.recovery.actorId, '500000000000000001');
  assert.equal(receipt.recovery.action, 'refund');
});

test('wager recovery rejects missing audit reason and unknown actions', async () => {
  const client = makeClient();
  await assert.rejects(
    recoverEconomyWager(client, guildId, memberA, 'missing-game', {
      action: 'refund', actorId: '500000000000000001', reason: '',
    }),
    /staff actor, reason, and valid recovery action are required/,
  );
});


test('recovered wagers cannot later settle or be accessed from another guild', async () => {
  const client = makeClient();
  const userId = '400000000000000005';
  const key = 'global:economy:' + userId;
  await client.db.set(key, { wallet: 700, bank: 0, inventory: {}, cooldowns: {} });
  await startEconomyWager(client, guildId, userId, 'recovered-game-2', 300);

  await assert.rejects(
    settleEconomyWager(client, 'another-guild', userId, 'recovered-game-2', 900),
    /No reserved wager exists for this game in this server/,
  );
  const recovery = await recoverEconomyWager(client, guildId, userId, 'recovered-game-2', {
    action: 'refund', actorId: '500000000000000001', reason: 'Abandoned game after restart.',
  });
  assert.equal(recovery.recovered, true);

  const lateSettlement = await settleEconomyWager(client, guildId, userId, 'recovered-game-2', 900);
  assert.equal(lateSettlement.settled, false);
  assert.equal(lateSettlement.status, 'refunded');
  assert.equal((await client.db.get(key)).wallet, 1000);
});
