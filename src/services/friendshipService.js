/**
 * Barracks Friendship and Soulmate relationship storage.
 * Pair records are permanent: removing a friend only deactivates the link.
 */
const keyFor = guildId => `guild:${guildId}:friendship_system`;
const DAY = 24 * 60 * 60 * 1000;
const REQUEST_TTL = 7 * DAY;
const SOULMATE_COOLDOWN = 7 * DAY;
const DAILY_PAIR_CAP = 30;
const locks = new Map();

async function locked(guildId, fn) {
  const prior = locks.get(guildId) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  const queued = prior.then(() => current);
  locks.set(guildId, queued);
  await prior;
  try { return await fn(); }
  finally { release(); if (locks.get(guildId) === queued) locks.delete(guildId); }
}

function normalize(raw) {
  return {
    friendships: raw?.friendships && typeof raw.friendships === 'object' ? raw.friendships : {},
    requests: raw?.requests && typeof raw.requests === 'object' ? raw.requests : {},
    soulmates: raw?.soulmates && typeof raw.soulmates === 'object' ? raw.soulmates : {},
    history: Array.isArray(raw?.history) ? raw.history : [],
    soulmateCooldowns: raw?.soulmateCooldowns && typeof raw.soulmateCooldowns === 'object' ? raw.soulmateCooldowns : {},
  };
}
const pairKey = (a, b) => [String(a), String(b)].sort().join(':');
const isActiveFriend = (pair, a, b) => pair?.active === true &&
  ((pair.member1Id === a && pair.member2Id === b) || (pair.member1Id === b && pair.member2Id === a));

export async function getFriendshipData(client, guildId) {
  if (!client?.db?.get) throw new Error('Friendship database is unavailable.');
  return normalize(await client.db.get(keyFor(guildId), null));
}
async function save(client, guildId, data) {
  if (!client?.db?.set) throw new Error('Friendship database is unavailable.');
  await client.db.set(keyFor(guildId), data);
}
export async function getFriendshipPoints(client, guildId, a, b) {
  if (!a || !b || a === b) return 0;
  const data = await getFriendshipData(client, guildId);
  return Number(data.friendships[pairKey(a, b)]?.points) || 0;
}
export async function areFriends(client, guildId, a, b) {
  const data = await getFriendshipData(client, guildId);
  return isActiveFriend(data.friendships[pairKey(a, b)], a, b);
}
export async function getActiveFriends(client, guildId, userId) {
  const data = await getFriendshipData(client, guildId);
  return Object.values(data.friendships).filter(p => p?.active &&
    (p.member1Id === userId || p.member2Id === userId)).map(p => ({
      ...p, friendId: p.member1Id === userId ? p.member2Id : p.member1Id,
    }));
}

/** A request is accepted by its recipient; pair history survives later removal. */
export async function sendFriendRequest(client, guildId, senderId, recipientId, options = {}) {
  if (!senderId || !recipientId || senderId === recipientId) return { status: 'invalid_target' };
  if (options.isBot) return { status: 'bot_target' };
  return locked(guildId, async () => {
    const data = await getFriendshipData(client, guildId);
    const pair = pairKey(senderId, recipientId);
    if (isActiveFriend(data.friendships[pair], senderId, recipientId)) return { status: 'already_friends' };
    if (Object.values(data.requests).some(r => r?.kind !== 'soulmate' && r?.status === 'pending' &&
      ((r.senderId === senderId && r.recipientId === recipientId) ||
       (r.senderId === recipientId && r.recipientId === senderId)))) return { status: 'duplicate_pending' };
    const id = `fr-${Date.now()}-${senderId}-${recipientId}`;
    const request = { id, senderId, recipientId, status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + REQUEST_TTL };
    data.requests[id] = request;
    await save(client, guildId, data);
    return { status: 'created', request };
  });
}
export async function resolveFriendRequest(client, guildId, requestId, recipientId, decision) {
  if (!['accepted', 'declined'].includes(decision)) return { status: 'invalid_decision' };
  return locked(guildId, async () => {
    const data = await getFriendshipData(client, guildId);
    const req = data.requests[requestId];
    if (!req || req.kind === 'soulmate' || req.status !== 'pending') return { status: 'not_pending' };
    if (req.recipientId !== recipientId) return { status: 'not_authorized' };
    const now = Date.now();
    if (now >= Number(req.expiresAt)) {
      req.status = 'expired'; req.updatedAt = now; await save(client, guildId, data);
      return { status: 'expired' };
    }
    req.status = decision; req.updatedAt = now;
    if (decision === 'accepted') {
      const id = pairKey(req.senderId, req.recipientId);
      const previous = data.friendships[id];
      data.friendships[id] = previous
        ? { ...previous, active: true, reactivatedAt: now }
        : { member1Id: req.senderId, member2Id: req.recipientId, points: 0, active: true, createdAt: now, dailyClaims: {}, activity: {} };
      data.history.push({ type: 'friendship', action: previous ? 'restored' : 'created', pairKey: id, at: now });
    }
    await save(client, guildId, data);
    return { status: decision, request: req, friendship: decision === 'accepted' ? data.friendships[pairKey(req.senderId, req.recipientId)] : null };
  });
}
export async function cancelFriendRequest(client, guildId, requestId, senderId) {
  return locked(guildId, async () => {
    const data = await getFriendshipData(client, guildId), req = data.requests[requestId];
    if (!req || req.status !== 'pending') return { status: 'not_pending' };
    if (req.senderId !== senderId) return { status: 'not_authorized' };
    req.status = 'cancelled'; req.updatedAt = Date.now(); await save(client, guildId, data);
    return { status: 'cancelled' };
  });
}
export async function removeFriend(client, guildId, userId, friendId) {
  return locked(guildId, async () => {
    const data = await getFriendshipData(client, guildId), id = pairKey(userId, friendId);
    const pair = data.friendships[id];
    if (!isActiveFriend(pair, userId, friendId)) return { status: 'not_friends' };
    pair.active = false; pair.removedAt = Date.now(); pair.removedBy = userId;
    data.history.push({ type: 'friendship', action: 'removed', pairKey: id, at: pair.removedAt, by: userId });
    await save(client, guildId, data);
    return { status: 'removed', friendship: pair };
  });
}

/** Award chat/voice FP with a caller-supplied unique activity key for deduplication. */
export async function awardFriendshipPoints(client, guildId, a, b, amount, options = {}) {
  if (!Number.isInteger(amount) || amount <= 0 || !a || !b || a === b) return { status: 'invalid_award' };
  return locked(guildId, async () => {
    const data = await getFriendshipData(client, guildId), id = pairKey(a, b), pair = data.friendships[id];
    if (!isActiveFriend(pair, a, b)) return { status: 'not_friends' };
    const now = Number(options.now) || Date.now(), day = new Date(now).toISOString().slice(0, 10);
    pair.activity ||= {};
    const activity = pair.activity[day] ||= { points: 0, keys: [] };
    if (options.activityKey && activity.keys.includes(String(options.activityKey))) return { status: 'duplicate_activity' };
    const granted = Math.min(amount, Math.max(0, DAILY_PAIR_CAP - (Number(activity.points) || 0)));
    if (!granted) return { status: 'daily_cap' };
    pair.points = (Number(pair.points) || 0) + granted;
    activity.points += granted;
    if (options.activityKey) activity.keys.push(String(options.activityKey));
    if (activity.keys.length > 500) activity.keys = activity.keys.slice(-500);
    await save(client, guildId, data);
    return { status: 'awarded', points: granted, total: pair.points, remainingToday: DAILY_PAIR_CAP - activity.points };
  });
}
export async function claimFriendshipDailyBonus(client, guildId, a, b, now = Date.now()) {
  return locked(guildId, async () => {
    const data = await getFriendshipData(client, guildId), id = pairKey(a, b), pair = data.friendships[id];
    if (!isActiveFriend(pair, a, b)) return { status: 'not_friends' };
    pair.dailyClaims ||= {};
    const day = new Date(now).toISOString().slice(0, 10);
    if (pair.dailyClaims[day]) return { status: 'already_claimed' };
    const activity = pair.activity?.[day] || { points: 0 };
    const granted = Math.min(5, Math.max(0, DAILY_PAIR_CAP - (Number(activity.points) || 0)));
    pair.points = (Number(pair.points) || 0) + granted;
    pair.activity ||= {}; pair.activity[day] ||= { points: 0, keys: [] };
    pair.activity[day].points += granted;
    pair.dailyClaims[day] = now;
    await save(client, guildId, data);
    return { status: 'claimed', points: granted, total: pair.points };
  });
}

export async function getActiveSoulmate(client, guildId, userId) {
  const data = await getFriendshipData(client, guildId);
  return Object.values(data.soulmates).find(s => s?.status === 'active' && (s.member1Id === userId || s.member2Id === userId)) || null;
}
export async function validateMarriageEligibility(client, guildId, a, b) {
  const points = await getFriendshipPoints(client, guildId, a, b);
  if (points < 1000) return { eligible: false, reason: `You need 1,000 FP together (currently ${points}).`, points };
  const data = await getFriendshipData(client, guildId);
  const soulmate = Object.values(data.soulmates).find(s => s?.status === 'active' &&
    ((s.member1Id === a && s.member2Id === b) || (s.member1Id === b && s.member2Id === a)));
  if (!soulmate) return { eligible: false, reason: 'Both members must have an active Soulmate relationship.', points };
  return { eligible: true, points, soulmate };
}
export async function createSoulmateRequest(client, guildId, senderId, recipientId, options = {}) {
  if (!senderId || !recipientId || senderId === recipientId) return { status: 'invalid_target' };
  if (options.isBot) return { status: 'bot_target' };
  return locked(guildId, async () => {
    const data = await getFriendshipData(client, guildId), now = Date.now(), id = pairKey(senderId, recipientId);
    const points = Number(data.friendships[id]?.points) || 0;
    if (!isActiveFriend(data.friendships[id], senderId, recipientId)) return { status: 'not_friends' };
    if (points < 800) return { status: 'insufficient_points', points, required: 800 };
    if (Object.values(data.soulmates).some(s => s?.status === 'active' && (s.member1Id === senderId || s.member2Id === senderId || s.member1Id === recipientId || s.member2Id === recipientId))) return { status: 'already_soulmates' };
    if ([senderId, recipientId].some(userId => now < (Number(data.soulmateCooldowns[userId]) || 0))) return { status: 'cooldown' };
    if (Object.values(data.requests).some(r => r?.kind === 'soulmate' && r.status === 'pending' &&
      ((r.senderId === senderId && r.recipientId === recipientId) || (r.senderId === recipientId && r.recipientId === senderId)))) return { status: 'duplicate_pending' };
    const requestId = `sm-${now}-${senderId}-${recipientId}`;
    const request = { id: requestId, kind: 'soulmate', senderId, recipientId, status: 'pending', createdAt: now, expiresAt: now + REQUEST_TTL };
    data.requests[requestId] = request; await save(client, guildId, data);
    return { status: 'created', request };
  });
}
export async function resolveSoulmateRequest(client, guildId, requestId, recipientId, decision) {
  if (!['accepted', 'declined'].includes(decision)) return { status: 'invalid_decision' };
  return locked(guildId, async () => {
    const data = await getFriendshipData(client, guildId), req = data.requests[requestId];
    if (!req || req.kind !== 'soulmate' || req.status !== 'pending') return { status: 'not_pending' };
    if (req.recipientId !== recipientId) return { status: 'not_authorized' };
    const now = Date.now();
    if (now >= Number(req.expiresAt)) { req.status = 'expired'; req.updatedAt = now; await save(client, guildId, data); return { status: 'expired' }; }
    if (decision === 'declined') { req.status = 'declined'; req.updatedAt = now; await save(client, guildId, data); return { status: 'declined' }; }
    const id = pairKey(req.senderId, req.recipientId), pair = data.friendships[id];
    if (!isActiveFriend(pair, req.senderId, req.recipientId) || Number(pair.points) < 800) return { status: 'not_eligible' };
    if (Object.values(data.soulmates).some(s => s?.status === 'active' && (s.member1Id === req.senderId || s.member2Id === req.senderId || s.member1Id === req.recipientId || s.member2Id === req.recipientId))) return { status: 'already_soulmates' };
    const soulmateId = `soulmate-${now}-${req.senderId}-${req.recipientId}`;
    const soulmate = { id: soulmateId, member1Id: req.senderId, member2Id: req.recipientId, status: 'active', startedAt: now };
    data.soulmates[soulmateId] = soulmate; req.status = 'accepted'; req.updatedAt = now;
    data.history.push({ type: 'soulmate', action: 'started', soulmateId, at: now });
    await save(client, guildId, data);
    return { status: 'accepted', soulmate };
  });
}
export async function endSoulmate(client, guildId, userId) {
  return locked(guildId, async () => {
    const data = await getFriendshipData(client, guildId), soulmate = Object.values(data.soulmates).find(s => s?.status === 'active' && (s.member1Id === userId || s.member2Id === userId));
    if (!soulmate) return { status: 'not_soulmates' };
    const now = Date.now(), other = soulmate.member1Id === userId ? soulmate.member2Id : soulmate.member1Id;
    soulmate.status = 'ended'; soulmate.endedAt = now; soulmate.endedBy = userId;
    data.soulmateCooldowns[userId] = now + SOULMATE_COOLDOWN;
    data.soulmateCooldowns[other] = now + SOULMATE_COOLDOWN;
    data.history.push({ type: 'soulmate', action: 'ended', soulmateId: soulmate.id, at: now, by: userId });
    await save(client, guildId, data);
    return { status: 'ended', soulmate, cooldownUntil: now + SOULMATE_COOLDOWN };
  });
}
export const FRIENDSHIP_DAILY_CAP = DAILY_PAIR_CAP;
export const FRIENDSHIP_REQUEST_TTL = REQUEST_TTL;
export const SOULMATE_COOLDOWN_MS = SOULMATE_COOLDOWN;
