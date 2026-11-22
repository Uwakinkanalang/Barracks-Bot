/**
 * Barracks marriage data service.
 *
 * Marriage records are stored per guild so the same member may participate
 * in separate community systems without sharing relationship state.
 */

const getMarriageKey = (guildId) => `guild:${guildId}:marriage_system`;

function normalizeMarriageData(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { proposals: {}, marriages: {}, history: [], transactions: {}, anniversaryClaims: {} };
  }

  return {
    proposals: value.proposals && typeof value.proposals === 'object' ? value.proposals : {},
    marriages: value.marriages && typeof value.marriages === 'object' ? value.marriages : {},
    history: Array.isArray(value.history) ? value.history : [],
    transactions: value.transactions && typeof value.transactions === 'object' ? value.transactions : {},
    anniversaryClaims: value.anniversaryClaims && typeof value.anniversaryClaims === 'object'
      ? value.anniversaryClaims : {},
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
