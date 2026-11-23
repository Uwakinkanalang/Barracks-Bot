function applyFormat(value, format) {
  if (format === 'uppercase') return value.toUpperCase();
  if (format === 'lowercase') return value.toLowerCase();
  if (format === 'title') return value.toLowerCase().replace(/\b\p{L}/gu, char => char.toUpperCase());
  return value;
}
export async function applyDashboardAutoNick(member, trigger = 'join') {
  if (!member?.guild || member.user?.bot) return false;
  const rules = await member.client.db.get(`guild:${member.guild.id}:autonick_dashboard_rules`, []);
  if (!Array.isArray(rules) || !rules.length) return false;
  const matching = rules.filter(rule => trigger === 'join'
    ? rule.type === 'join'
    : rule.type === 'role' && member.roles.cache.has(String(rule.roleId)));
  if (!matching.length) return false;
  const rule = matching.sort((a,b) => Number(b.priority || 0) - Number(a.priority || 0))[0];
  const serverDisplayName = member.displayName || member.nickname || member.user.globalName || member.user.username;
  const values = {
    username: serverDisplayName,
    displayname: serverDisplayName,
    userid: member.id,
    server: member.guild.name
  };
  let nickname = String(rule.nickname || '').replace(/\{(username|displayname|userid|server)\}/gi, (_, key) => values[key.toLowerCase()] ?? '');
  nickname = applyFormat(nickname, rule.format);
  nickname = nickname.trim().slice(0, 32);
  if (!nickname || member.nickname === nickname || !member.manageable) return false;
  await member.setNickname(nickname, 'Apply dashboard AutoNick rule');
  return true;
}
