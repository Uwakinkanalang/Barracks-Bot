import { SlashCommandBuilder } from 'discord.js';
import { isBotOwner } from '../../config/bot.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { getAFKKey } from '../../utils/database.js';
import { logger } from '../../utils/logger.js';
import { getGuildConfig } from '../../services/config/guildConfig.js';

const CONFIG_KEY = (guildId) => `guild:${guildId}:autonick_roles`;
const DEFAULT_SERVER_MANAGER_ROLE_IDS = ['1466364437622423694'];
const normalize = (items) => (Array.isArray(items) ? items : []).filter((x) => x && typeof x.roleId === 'string' && typeof x.prefix === 'string').map((x) => ({ roleId: x.roleId, prefix: x.prefix, priority: Number(x.priority) || 0 })).sort((a, b) => b.priority - a.priority);

async function refreshGuildAutoNick(guild, configs, prefixesToStrip = configs.map(entry => entry.prefix)) {
  const client = guild.client;
  // Do not request a full guild member download from a slash command: large
  // guilds can take too long and leave the interaction showing "thinking".
  const members = new Map(guild.members.cache);
  for (const entry of configs) {
    const role = guild.roles.cache.get(entry.roleId);
    if (role) {
      for (const member of role.members.values()) members.set(member.id, member);
    }
  }
  const prefixes = [...new Set(prefixesToStrip.map(value => String(value || '').trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  let updated = 0;
  let failed = 0;

  for (const member of members.values()) {
    if (member.user.bot) continue;
    const stateKey = `guild:${guild.id}:autonick_member:${member.id}`;
    const state = await client.db.get(stateKey, null);
    const active = configs
      .filter(entry => member.roles.cache.has(entry.roleId))
      .sort((a, b) => b.priority - a.priority)[0] || null;

    // Prefer the persisted unprefixed nickname. For legacy members, remove any
    // configured prefix repeatedly before establishing the base nickname.
    let base = typeof state?.originalNickname === 'string'
      ? state.originalNickname
      : (member.nickname ?? member.user.globalName ?? member.user.username);
    base = String(base).replace(/^\[AFK\]\s*/u, '').trimStart();
    let matched;
    do {
      matched = prefixes.find(prefix => base.startsWith(prefix));
      if (matched) base = base.slice(matched.length).trimStart();
    } while (matched);
    if (!base.trim()) base = member.user.globalName || member.user.username;

    let desired;
    if (active) {
      await client.db.set(stateKey, { originalNickname: base, savedAt: state?.savedAt || Date.now() });
      desired = `${active.prefix.trim()} ${base}`.slice(0, 32);
    } else if (state) {
      desired = base || null;
      await client.db.delete(stateKey).catch(() => {});
    } else {
      continue;
    }

    const afkKey = getAFKKey(guild.id, member.id);
    const afk = await client.db.get(afkKey, null);
    if (afk) {
      afk.originalNickname = desired;
      afk.afkNickname = desired ? `[AFK] ${desired}`.slice(0, 32) : null;
      await client.db.set(afkKey, afk);
      desired = afk.afkNickname;
    }

    if (member.nickname !== desired) {
      try {
        await member.setNickname(desired, 'Refresh configured AutoNick priority and prefix');
        updated += 1;
      } catch (error) {
        failed += 1;
        logger.warn(`[AUTO_NICKNAME] Could not refresh ${member.user.tag}: ${error.message}`);
      }
    }
  }

  return { updated, failed, checked: members.size };
}

export default {
  data: new SlashCommandBuilder().setName('autonick').setDescription('Configure automatic nickname prefixes for Barracks roles')
    .addSubcommand(s => s.setName('add').setDescription('Add a role nickname prefix').addRoleOption(o => o.setName('role').setDescription('Role to monitor').setRequired(true)).addStringOption(o => o.setName('prefix').setDescription('Nickname prefix, e.g. 👮|').setRequired(true).setMaxLength(12)).addIntegerOption(o => o.setName('priority').setDescription('Higher number wins').setRequired(true).setMinValue(1).setMaxValue(1000)))
    .addSubcommand(s => s.setName('edit').setDescription('Edit a configured role').addRoleOption(o => o.setName('role').setDescription('Configured role').setRequired(true)).addStringOption(o => o.setName('prefix').setDescription('New prefix').setMaxLength(12)).addIntegerOption(o => o.setName('priority').setDescription('New priority').setMinValue(1).setMaxValue(1000)))
    .addSubcommand(s => s.setName('remove').setDescription('Remove a role from AutoNick').addRoleOption(o => o.setName('role').setDescription('Configured role').setRequired(true)))
    .addSubcommand(s => s.setName('list').setDescription('List configured AutoNick roles')),
  async execute(interaction) {
    if (!interaction.inGuild()) return interaction.reply({ content: 'Use this command inside the Barracks server.', ephemeral: true });
    // AutoNick settings are restricted to the Server Manager roles configured in the dashboard.
    const guildConfig = await getGuildConfig(interaction.client, interaction.guildId);
    const managerRoleIds = [...new Set([...(Array.isArray(guildConfig.managerRoleIds) ? guildConfig.managerRoleIds : []), ...DEFAULT_SERVER_MANAGER_ROLE_IDS])];
    const isManager = managerRoleIds.some(roleId => interaction.member?.roles?.cache?.has(roleId));
    if (!isManager && !isBotOwner(interaction.user.id)) {
      return interaction.reply({
        content: 'You need one of the configured **Server Manager** roles to use /autonick.',
        ephemeral: true,
      });
    }
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;
    const { guild, client } = interaction;
    const sub = interaction.options.getSubcommand();
    const entries = normalize(await client.db.get(CONFIG_KEY(guild.id), []));
    const role = interaction.options.getRole('role');
    try {
    if (sub === 'add') {
      const prefix = interaction.options.getString('prefix').trim();
      const priority = interaction.options.getInteger('priority');
      if (!prefix) return InteractionHelper.safeEditReply(interaction, { content: 'Prefix cannot be empty.' });
      if (role.id === guild.id || role.managed || role.position >= (guild.members.me?.roles.highest.position ?? 0)) return InteractionHelper.safeEditReply(interaction, { content: 'I cannot manage that role. Choose a normal role below my highest role.' });
      if (entries.some(x => x.roleId === role.id)) return InteractionHelper.safeEditReply(interaction, { content: `${role} is already configured. Use /autonick edit to change it.` });
      const previousConfigs = entries.slice();
      entries.push({ roleId: role.id, prefix, priority });
      const updatedConfigs = normalize(entries);
      await client.db.set(CONFIG_KEY(guild.id), updatedConfigs);
      const result = await refreshGuildAutoNick(guild, updatedConfigs, [...previousConfigs.map(x => x.prefix), ...updatedConfigs.map(x => x.prefix)]);
      return InteractionHelper.safeEditReply(interaction, { content: `✅ Added ${role} with prefix **${prefix}** and priority **${priority}**. Refreshed ${result.updated} member(s)${result.failed ? `; ${result.failed} failed due to nickname permissions` : ''}.` });
    }
    if (sub === 'edit') {
      const index = entries.findIndex(x => x.roleId === role.id);
      if (index < 0) return InteractionHelper.safeEditReply(interaction, { content: `${role} is not configured. Use /autonick add first.` });
      const prefix = interaction.options.getString('prefix');
      const priority = interaction.options.getInteger('priority');
      if (prefix === null && priority === null) return InteractionHelper.safeEditReply(interaction, { content: 'Provide a new prefix, priority, or both.' });
      const previousConfigs = entries.map(entry => ({ ...entry }));
      if (prefix !== null) { if (!prefix.trim()) return InteractionHelper.safeEditReply(interaction, { content: 'Prefix cannot be empty.' }); entries[index].prefix = prefix.trim(); }
      if (priority !== null) entries[index].priority = priority;
      const updatedConfigs = normalize(entries);
      await client.db.set(CONFIG_KEY(guild.id), updatedConfigs);
      const result = await refreshGuildAutoNick(guild, updatedConfigs, [...previousConfigs.map(x => x.prefix), ...updatedConfigs.map(x => x.prefix)]);
      const updatedEntry = updatedConfigs.find(entry => entry.roleId === role.id);
      return InteractionHelper.safeEditReply(interaction, { content: `✅ Updated ${role}: prefix **${updatedEntry.prefix}**, priority **${updatedEntry.priority}**. Refreshed ${result.updated} member(s)${result.failed ? `; ${result.failed} failed due to nickname permissions` : ''}.` });
    }
    if (sub === 'remove') {
      const updated = entries.filter(x => x.roleId !== role.id);
      if (updated.length === entries.length) return InteractionHelper.safeEditReply(interaction, { content: `${role} is not configured in AutoNick.` });
      await client.db.set(CONFIG_KEY(guild.id), updated);
      const result = await refreshGuildAutoNick(guild, updated, entries.map(x => x.prefix));
      return InteractionHelper.safeEditReply(interaction, { content: `✅ Removed ${role} from AutoNick. Refreshed ${result.updated} member(s)${result.failed ? `; ${result.failed} failed due to nickname permissions` : ''}.` });
    }
    if (!entries.length) return InteractionHelper.safeEditReply(interaction, { content: 'No AutoNick roles configured. Use /autonick add first.' });
    const rows = entries.map((x, i) => `**${i + 1}.** ${guild.roles.cache.get(x.roleId) || `Deleted role (${x.roleId})`} — prefix **${x.prefix}** — priority **${x.priority}**`);
    return InteractionHelper.safeEditReply(interaction, { content: `**Barracks AutoNick Roles**\n${rows.join('\n')}\n\nHigher priority numbers take precedence.` });
    } catch (error) {
      logger.error('[AUTO_NICKNAME] Command failed:', error);
      return InteractionHelper.safeEditReply(interaction, {
        content: '❌ AutoNick could not finish. Check the bot logs for the error. Make sure the bot has Manage Nicknames permission and its role is above the members it needs to rename.',
      });
    }
  },
};