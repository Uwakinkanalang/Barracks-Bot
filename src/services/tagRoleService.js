import { logger } from '../utils/logger.js';

export async function syncTagRoleForMember(member) {
  if (!member?.guild || !member.user || member.user.bot) return false;
  const primaryGuild = member.user.primaryGuild;
  // Partial user payloads can omit primary_guild; wait for a complete update.
  if (typeof primaryGuild === 'undefined') return false;
  const config = await member.client.db.get(`guild:${member.guild.id}:tag-role-config`, { enabled: false, roleId: '' });
  if (!config?.enabled || !config.roleId) return false;
  const role = member.guild.roles.cache.get(String(config.roleId));
  if (!role || role.managed || !role.editable) {
    logger.warn(`[TAG_ROLE] Configured role ${config.roleId} is missing or not manageable in guild ${member.guild.id}`);
    return false;
  }
  const representsGuild = primaryGuild?.identityEnabled === true && String(primaryGuild.identityGuildId || '') === member.guild.id;
  const hasRole = member.roles.cache.has(role.id);
  if (representsGuild && !hasRole) { await member.roles.add(role, 'Member is displaying this server tag'); return true; }
  if (!representsGuild && hasRole) { await member.roles.remove(role, 'Member is no longer displaying this server tag'); return true; }
  return false;
}
