/**
 * Barracks marriage data service.
 *
 * Marriage records are stored per guild so the same member may participate
 * in separate community systems without sharing relationship state.
 */

const getMarriageKey = (guildId) => `guild:${guildId}:marriage_system`;
const PROPOSAL_FEE = 100000;
const PROPOSAL_TTL = 7 * 24 * 60 * 60 * 1000;
const REPROPOSAL_COOLDOWN = 7 * 24 * 60 * 60 * 1000;
const guildLocks = new Map();

async function withGuildLock(guildId, callback) {
  const previous = guildLocks.get(guildId) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  guildLocks.set(guildId, queued);
  await previous;
  try { return await callback(); }
  finally {
    release();
    if (guildLocks.get(guildId) === queued) guildLocks.delete(guildId);
  }
}

function normalizeMarriageData(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { proposals: {}, marriages: {}, history: [], transactions: {}, anniversaryClaims: {}, divorceCooldowns: {} };
  }

  return {
    proposals: value.proposals && typeof value.proposals === 'object' ? value.proposals : {},
    marriages: value.marriages && typeof value.marriages === 'object' ? value.marriages : {},
    history: Array.isArray(value.history) ? value.history : [],
    transactions: value.transactions && typeof value.transactions === 'object' ? value.transactions : {},
    anniversaryClaims: value.anniversaryClaims && typeof value.anniversaryClaims === 'object'
      ? value.anniversaryClaims : {},
    divorceCooldowns: value.divorceCooldowns && typeof value.divorceCooldowns === 'object'
      ? value.divorceCooldowns : {},
  };
}

export async function getMarriageData(client, guildId) {
  if (!client?.db || typeof client.db.get !== 'function') {
    throw new Error('Marriage database is unavailable.');
  }

  const stored = await client.db.get(getMarriageKey(guildId), null);
  return normalizeMarriageData(stored);
}

export async function saveMarriageData(client, guildId, data) {
  if (!client?.db || typeof client.db.set !== 'function') {
    throw new Error('Marriage database is unavailable.');
  }

  await client.db.set(getMarriageKey(guildId), normalizeMarriageData(data));
  return true;
}

/**
 * Returns the active marriage involving a member, or null.
 * Active records use status === 'married' and store spouse IDs as member1Id/member2Id.
 */
export async function getActiveMarriage(client, guildId, userId) {
  const data = await getMarriageData(client, guildId);

  for (const marriage of Object.values(data.marriages)) {
    if (!marriage || marriage.status !== 'married') continue;

    const isMember = marriage.member1Id === userId || marriage.member2Id === userId;
    if (!isMember) continue;

    const spouseId = marriage.member1Id === userId
      ? marriage.member2Id
      : marriage.member1Id;

    return { ...marriage, spouseId };
  }

  return null;
}


async function syncMarriageRole(client, guildId, memberIds, shouldHaveRole) {
  const { getGuildConfig } = await import('./config/guildConfig.js');
  const config = await getGuildConfig(client, guildId);
  const roleId = config.marriedRoleId;
  if (!roleId) return { status: 'not_configured' };

  const guild = client.guilds?.cache?.get(guildId);
  if (!guild) return { status: 'guild_unavailable' };

  const role = await guild.roles.fetch(roleId).catch(() => null);
  if (!role) return { status: 'role_not_found' };
  if (role.name !== '💍B-Married') {
    return { status: 'wrong_role_name', expectedName: '💍B-Married', actualName: role.name };
  }

  const results = [];
  for (const userId of memberIds) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) { results.push({ userId, status: 'member_not_found' }); continue; }
    try {
      if (shouldHaveRole && !member.roles.cache.has(roleId)) {
        await member.roles.add(roleId, 'Barracks marriage accepted');
      } else if (!shouldHaveRole && member.roles.cache.has(roleId)) {
        await member.roles.remove(roleId, 'Barracks marriage ended');
      }
      results.push({ userId, status: 'synced' });
    } catch (error) {
      results.push({ userId, status: 'failed', message: error.message });
    }
  }
  return { status: 'completed', results };
}

function pairKey(firstId, secondId) {
  return [String(firstId), String(secondId)].sort().join(':');
}

function hasActiveMarriage(data, userId) {
  return Object.values(data.marriages).some((record) =>
    record?.status === 'married' &&
    (record.member1Id === userId || record.member2Id === userId)
  );
}

function findPendingProposal(data, proposerId, recipientId) {
  return Object.values(data.proposals).find((proposal) =>
    proposal?.status === 'pending' &&
    proposal.proposerId === proposerId &&
    proposal.recipientId === recipientId
  );
}

/**
 * Create a proposal and charge the proposer 100,000 bCash.
 * Eligibility (1,000 FP + active Soulmate status) is deliberately required
 * from the caller until the Friendship/Soulmate services are integrated.
 */
export async function createMarriageProposal(client, guildId, proposerId, recipientId, options = {}) {
  if (!proposerId || !recipientId || proposerId === recipientId) {
    return { status: 'invalid_target' };
  }
  if (options.isBot) return { status: 'bot_target' };
  if (typeof options.validateEligibility !== 'function') {
    return { status: 'eligibility_service_unavailable' };
  }

  return withGuildLock(guildId, async () => {
    const eligibility = await options.validateEligibility(proposerId, recipientId);
    if (!eligibility?.eligible) return { status: 'not_eligible', reason: eligibility?.reason || 'Eligibility requirements not met.' };

    const data = await getMarriageData(client, guildId);
    const now = Date.now();
    if (hasActiveMarriage(data, proposerId) || hasActiveMarriage(data, recipientId)) {
      return { status: 'already_married' };
    }
    if (findPendingProposal(data, proposerId, recipientId)) {
      return { status: 'duplicate_pending' };
    }

    const pair = pairKey(proposerId, recipientId);
    const previous = data.history
      .filter((item) => item.type === 'proposal' && item.pairKey === pair &&
        ['declined', 'expired'].includes(item.status))
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))[0];
    if (previous && now < Number(previous.updatedAt || 0) + REPROPOSAL_COOLDOWN) {
      return { status: 'proposal_cooldown', retryAt: Number(previous.updatedAt) + REPROPOSAL_COOLDOWN };
    }

    const { getEconomyData, setEconomyData } = await import('../utils/economy.js');
    const economy = await getEconomyData(client, guildId, proposerId);
    if (!economy || Number(economy.wallet) < PROPOSAL_FEE) {
      return { status: 'insufficient_funds', required: PROPOSAL_FEE };
    }

    const proposalId = `mp-${now}-${proposerId}-${recipientId}`;
    const proposal = {
      id: proposalId,
      proposerId,
      recipientId,
      fee: PROPOSAL_FEE,
      status: 'pending',
      createdAt: now,
      expiresAt: now + PROPOSAL_TTL,
    };

    economy.wallet = Number(economy.wallet) - PROPOSAL_FEE;
    const savedEconomy = await setEconomyData(client, guildId, proposerId, economy);
    if (!savedEconomy) return { status: 'payment_failed' };

    try {
      data.proposals[proposalId] = proposal;
      data.transactions[proposalId] = {
        type: 'proposal_fee',
        userId: proposerId,
        amount: PROPOSAL_FEE,
        createdAt: now,
      };
      await saveMarriageData(client, guildId, data);
    } catch (error) {
      economy.wallet = Number(economy.wallet) + PROPOSAL_FEE;
      await setEconomyData(client, guildId, proposerId, economy);
      throw error;
    }

    return { status: 'created', proposal };
  });
}

export async function cancelMarriageProposal(client, guildId, proposalId, userId) {
  return withGuildLock(guildId, async () => {
    const data = await getMarriageData(client, guildId);
    const proposal = data.proposals[proposalId];
    if (!proposal || proposal.status !== 'pending') return { status: 'not_pending' };
    if (proposal.proposerId !== userId) return { status: 'not_authorized' };

    proposal.status = 'cancelled';
    proposal.updatedAt = Date.now();
    await saveMarriageData(client, guildId, data);
    return { status: 'cancelled', proposal };
  });
}

export async function resolveMarriageProposal(client, guildId, proposalId, recipientId, decision, options = {}) {
  if (!['accepted', 'declined'].includes(decision)) return { status: 'invalid_decision' };

  return withGuildLock(guildId, async () => {
    const data = await getMarriageData(client, guildId);
    const proposal = data.proposals[proposalId];
    if (!proposal || proposal.status !== 'pending') return { status: 'not_pending' };
    if (proposal.recipientId !== recipientId) return { status: 'not_authorized' };

    const now = Date.now();
    if (now >= Number(proposal.expiresAt)) {
      proposal.status = 'expired';
      proposal.updatedAt = now;
      data.history.push({ type: 'proposal', pairKey: pairKey(proposal.proposerId, proposal.recipientId), status: 'expired', updatedAt: now, proposalId });
      await saveMarriageData(client, guildId, data);
      return { status: 'expired' };
    }

    if (decision === 'accepted') {
      if (typeof options.validateEligibility !== 'function') return { status: 'eligibility_service_unavailable' };
      const eligibility = await options.validateEligibility(proposal.proposerId, proposal.recipientId);
      if (!eligibility?.eligible) return { status: 'not_eligible', reason: eligibility?.reason || 'Eligibility requirements are no longer met.' };
      if (hasActiveMarriage(data, proposal.proposerId) || hasActiveMarriage(data, proposal.recipientId)) {
        return { status: 'already_married' };
      }
      return { status: 'ready_to_finalize', proposal };
    }

    proposal.status = 'declined';
    proposal.updatedAt = now;
    data.history.push({ type: 'proposal', pairKey: pairKey(proposal.proposerId, proposal.recipientId), status: 'declined', updatedAt: now, proposalId });
    await saveMarriageData(client, guildId, data);
    return { status: 'declined', proposal };
  });
}

export async function expireMarriageProposals(client, guildId, now = Date.now()) {
  return withGuildLock(guildId, async () => {
    const data = await getMarriageData(client, guildId);
    const expired = [];
    for (const proposal of Object.values(data.proposals)) {
      if (proposal?.status !== 'pending' || now < Number(proposal.expiresAt)) continue;
      proposal.status = 'expired';
      proposal.updatedAt = now;
      expired.push(proposal);
      data.history.push({ type: 'proposal', pairKey: pairKey(proposal.proposerId, proposal.recipientId), status: 'expired', updatedAt: now, proposalId: proposal.id });
    }
    if (expired.length) await saveMarriageData(client, guildId, data);
    return expired;
  });
}

export const MARRIAGE_PROPOSAL_FEE = PROPOSAL_FEE;
export const MARRIAGE_PROPOSAL_TTL = PROPOSAL_TTL;


/**
 * Finalize a proposal after the recipient has accepted and eligibility has
 * been revalidated. Returns the new active marriage record.
 */
export async function finalizeMarriageProposal(client, guildId, proposalId, recipientId, options = {}) {
  return withGuildLock(guildId, async () => {
    const data = await getMarriageData(client, guildId);
    const proposal = data.proposals[proposalId];
    if (!proposal || proposal.status !== 'pending') return { status: 'not_pending' };
    if (proposal.recipientId !== recipientId) return { status: 'not_authorized' };

    const now = Date.now();
    if (now >= Number(proposal.expiresAt)) {
      proposal.status = 'expired';
      proposal.updatedAt = now;
      data.history.push({ type: 'proposal', pairKey: pairKey(proposal.proposerId, proposal.recipientId), status: 'expired', updatedAt: now, proposalId });
      await saveMarriageData(client, guildId, data);
      return { status: 'expired' };
    }

    if (typeof options.validateEligibility !== 'function') return { status: 'eligibility_service_unavailable' };
    const eligibility = await options.validateEligibility(proposal.proposerId, proposal.recipientId);
    if (!eligibility?.eligible) return { status: 'not_eligible', reason: eligibility?.reason || 'Eligibility requirements are no longer met.' };
    if (hasActiveMarriage(data, proposal.proposerId) || hasActiveMarriage(data, proposal.recipientId)) {
      return { status: 'already_married' };
    }

    const marriageId = `marriage-${now}-${proposal.proposerId}-${proposal.recipientId}`;
    const marriage = {
      id: marriageId,
      member1Id: proposal.proposerId,
      member2Id: proposal.recipientId,
      status: 'married',
      marriedAt: now,
      proposalId,
      anniversaryRewards: { [proposal.proposerId]: 0, [proposal.recipientId]: 0 },
    };

    proposal.status = 'accepted';
    proposal.updatedAt = now;
    data.marriages[marriageId] = marriage;
    data.history.push({
      type: 'marriage',
      marriageId,
      member1Id: proposal.proposerId,
      member2Id: proposal.recipientId,
      marriedAt: now,
      status: 'married',
    });
    await saveMarriageData(client, guildId, data);
    const roleSync = await syncMarriageRole(client, guildId, [marriage.member1Id, marriage.member2Id], true);
    return { status: 'married', marriage, roleSync };
  });
}


const DIVORCE_FEE = 100000;
const DIVORCE_COOLDOWN = 7 * 24 * 60 * 60 * 1000;

/**
 * Finalize divorce after an explicit confirmation from the initiating spouse.
 * The initiator pays 100,000 bCash; both members receive a 7-day remarriage cooldown.
 */
export async function divorceMarriage(client, guildId, initiatorId, options = {}) {
  if (options.confirmed !== true) return { status: 'confirmation_required', fee: DIVORCE_FEE };

  return withGuildLock(guildId, async () => {
    const data = await getMarriageData(client, guildId);
    const marriage = Object.values(data.marriages).find((record) =>
      record?.status === 'married' &&
      (record.member1Id === initiatorId || record.member2Id === initiatorId)
    );

    if (!marriage) return { status: 'not_married' };

    const spouseId = marriage.member1Id === initiatorId
      ? marriage.member2Id
      : marriage.member1Id;

    const { getEconomyData, setEconomyData } = await import('../utils/economy.js');
    const economy = await getEconomyData(client, guildId, initiatorId);
    if (!economy || Number(economy.wallet) < DIVORCE_FEE) {
      return { status: 'insufficient_funds', required: DIVORCE_FEE };
    }

    const now = Date.now();
    const previousWallet = Number(economy.wallet);
    economy.wallet = previousWallet - DIVORCE_FEE;
    const paid = await setEconomyData(client, guildId, initiatorId, economy);
    if (!paid) return { status: 'payment_failed' };

    try {
      marriage.status = 'divorced';
      marriage.divorcedAt = now;
      marriage.divorceInitiatedBy = initiatorId;
      marriage.divorceFee = DIVORCE_FEE;
      marriage.durationMs = Math.max(0, now - Number(marriage.marriedAt || now));

      data.divorceCooldowns[initiatorId] = now + DIVORCE_COOLDOWN;
      data.divorceCooldowns[spouseId] = now + DIVORCE_COOLDOWN;
      data.transactions[`divorce-${marriage.id}-${now}`] = {
        type: 'divorce_fee',
        userId: initiatorId,
        spouseId,
        marriageId: marriage.id,
        amount: DIVORCE_FEE,
        createdAt: now,
      };
      data.history.push({
        type: 'divorce',
        marriageId: marriage.id,
        member1Id: marriage.member1Id,
        member2Id: marriage.member2Id,
        initiatedBy: initiatorId,
        divorcedAt: now,
        durationMs: marriage.durationMs,
        fee: DIVORCE_FEE,
      });
      await saveMarriageData(client, guildId, data);
    } catch (error) {
      economy.wallet = previousWallet;
      await setEconomyData(client, guildId, initiatorId, economy);
      throw error;
    }

    const roleSync = await syncMarriageRole(client, guildId, [marriage.member1Id, marriage.member2Id], false);

    return {
      status: 'divorced',
      marriage,
      initiatorId,
      spouseId,
      fee: DIVORCE_FEE,
      cooldownUntil: now + DIVORCE_COOLDOWN,
      roleSync,
    };
  });
}

export async function getMarriageCooldown(client, guildId, userId) {
  const data = await getMarriageData(client, guildId);
  const cooldownUntil = Number(data.divorceCooldowns[userId]) || 0;
  return {
    onCooldown: Date.now() < cooldownUntil,
    cooldownUntil,
    remaining: Math.max(0, cooldownUntil - Date.now()),
  };
}

export const MARRIAGE_DIVORCE_FEE = DIVORCE_FEE;
export const MARRIAGE_DIVORCE_COOLDOWN = DIVORCE_COOLDOWN;


const ANNIVERSARY_REWARD = 1000000;

function getAnniversaryDate(marriedAt, yearNumber) {
  const date = new Date(Number(marriedAt));
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCFullYear(date.getUTCFullYear() + yearNumber);
  date.setUTCMonth(month);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), month + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.getTime();
}

/**
 * Pays each completed yearly anniversary once.
 * Intended to be called by a scheduled guild job; returns payments for announcements.
 */
export async function processMarriageAnniversaries(client, guildId, now = Date.now()) {
  return withGuildLock(guildId, async () => {
    const data = await getMarriageData(client, guildId);
    const payments = [];

    for (const marriage of Object.values(data.marriages)) {
      if (marriage?.status !== 'married' || !marriage.member1Id || !marriage.member2Id) continue;
      const marriedAt = Number(marriage.marriedAt);
      if (!Number.isFinite(marriedAt) || marriedAt <= 0) continue;

      let anniversaryNumber = 1;
      while (getAnniversaryDate(marriedAt, anniversaryNumber) <= now) {
        const claimKey = `${marriage.id}:${anniversaryNumber}`;
        if (!data.anniversaryClaims[claimKey]) {
          const memberIds = [marriage.member1Id, marriage.member2Id];
          const snapshots = [];
          let paymentFailed = false;

          for (const userId of memberIds) {
            const { getEconomyData, setEconomyData } = await import('../utils/economy.js');
            const economy = await getEconomyData(client, guildId, userId);
            if (!economy) { paymentFailed = true; break; }
            snapshots.push({ userId, economy: { ...economy }, previousWallet: Number(economy.wallet) || 0 });
            economy.wallet = (Number(economy.wallet) || 0) + ANNIVERSARY_REWARD;
            if (!await setEconomyData(client, guildId, userId, economy)) {
              paymentFailed = true;
              break;
            }
          }

          if (paymentFailed) {
            for (const snapshot of snapshots) {
              const { setEconomyData } = await import('../utils/economy.js');
              await setEconomyData(client, guildId, snapshot.userId, {
                ...snapshot.economy,
                wallet: snapshot.previousWallet,
              });
            }
            break;
          }

          const paidAt = Date.now();
          data.anniversaryClaims[claimKey] = {
            marriageId: marriage.id,
            anniversaryNumber,
            paidAt,
            amountPerSpouse: ANNIVERSARY_REWARD,
            member1Id: marriage.member1Id,
            member2Id: marriage.member2Id,
          };
          marriage.anniversaryRewards ||= {};
          marriage.anniversaryRewards[marriage.member1Id] =
            (Number(marriage.anniversaryRewards[marriage.member1Id]) || 0) + ANNIVERSARY_REWARD;
          marriage.anniversaryRewards[marriage.member2Id] =
            (Number(marriage.anniversaryRewards[marriage.member2Id]) || 0) + ANNIVERSARY_REWARD;
          payments.push({
            marriageId: marriage.id,
            anniversaryNumber,
            member1Id: marriage.member1Id,
            member2Id: marriage.member2Id,
            amountPerSpouse: ANNIVERSARY_REWARD,
            paidAt,
          });
        }
        anniversaryNumber += 1;
      }
    }

    if (payments.length) await saveMarriageData(client, guildId, data);
    return payments;
  });
}

export const MARRIAGE_ANNIVERSARY_REWARD = ANNIVERSARY_REWARD;
