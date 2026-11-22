const STORAGE_KEY = guildId => `guild:${guildId}:clan_battles`;
const ACTIVE_GAMES = new Set(['tictactoe']);
export const CLAN_BATTLE_GAME_POINTS = Object.freeze({ tictactoe: 10 });

function normalizeClan(clan) {
  return {
    ...clan,
    memberIds: Array.isArray(clan.memberIds) ? clan.memberIds.map(String) : [],
    leaderId: String(clan.leaderId || ''),
    viceLeaderId: String(clan.viceLeaderId || ''),
  };
}

export function getClanForMember(clans, userId) {
  const id = String(userId);
  return (Array.isArray(clans) ? clans : []).map(normalizeClan).find(clan =>
    clan.status === 'approved' &&
    (clan.leaderId === id || clan.viceLeaderId === id || clan.memberIds.includes(id))
  ) || null;
}

export function canManageClanBattle(clan, userId) {
  return Boolean(clan && [clan.leaderId, clan.viceLeaderId].includes(String(userId)));
}

export async function getClanBattleState(client, guildId) {
  const saved = await client.db.get(STORAGE_KEY(guildId), null);
  const state = saved && typeof saved === 'object' ? saved : {};
  return {
    active: state.active && typeof state.active === 'object' ? state.active : null,
    history: Array.isArray(state.history) ? state.history : [],
  };
}

export async function saveClanBattleState(client, guildId, state) {
  await client.db.set(STORAGE_KEY(guildId), state);
}

export async function recordClanBattleGame(client, guildId, gameName, playerOneId, playerTwoId, winnerId) {
  const game = String(gameName || '').toLowerCase();
  if (!ACTIVE_GAMES.has(game) || !winnerId) return { recorded: false, reason: 'unsupported-game' };

  const clans = await client.db.get(`guild:${guildId}:clans`, []);
  const clanOne = getClanForMember(clans, playerOneId);
  const clanTwo = getClanForMember(clans, playerTwoId);
  if (!clanOne || !clanTwo || clanOne.id === clanTwo.id) return { recorded: false, reason: 'not-opposing-clans' };

  const state = await getClanBattleState(client, guildId);
  const battle = state.active;
  if (!battle || battle.status !== 'active') return { recorded: false, reason: 'no-active-battle' };

  const participants = new Set([String(playerOneId), String(playerTwoId)]);
  const battleClanIds = new Set([String(battle.clanAId), String(battle.clanBId)]);
  if (!battleClanIds.has(String(clanOne.id)) || !battleClanIds.has(String(clanTwo.id))) {
    return { recorded: false, reason: 'not-battle-clans' };
  }
  if (participants.size !== 2) return { recorded: false, reason: 'invalid-match' };

  const winnerClan = String(winnerId) === String(playerOneId) ? clanOne
    : String(winnerId) === String(playerTwoId) ? clanTwo : null;
  if (!winnerClan) return { recorded: false, reason: 'invalid-winner' };

  const matchKey = `${game}:${[String(playerOneId), String(playerTwoId)].sort().join(':')}`;
  battle.recordedMatches = Array.isArray(battle.recordedMatches) ? battle.recordedMatches : [];
  if (battle.recordedMatches.includes(matchKey)) return { recorded: false, reason: 'duplicate-match' };

  const points = Number(battle.gamePoints?.[game] ?? CLAN_BATTLE_GAME_POINTS[game] ?? 0);
  if (!Number.isSafeInteger(points) || points <= 0) return { recorded: false, reason: 'game-disabled' };
  const scoreKey = String(winnerClan.id) === String(battle.clanAId) ? 'clanAScore' : 'clanBScore';
  battle[scoreKey] = (Number(battle[scoreKey]) || 0) + points;
  battle.recordedMatches.push(matchKey);
  battle.results = Array.isArray(battle.results) ? battle.results : [];
  battle.results.push({ game, winnerId: String(winnerId), points, createdAt: Date.now() });
  await saveClanBattleState(client, guildId, state);
  return { recorded: true, points, clanName: winnerClan.name };
}

export function isSupportedClanBattleGame(gameName) {
  return ACTIVE_GAMES.has(String(gameName || '').toLowerCase());
}
