import { SlashCommandBuilder } from 'discord.js';
import { isBotOwner } from '../../config/bot.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

const CONFIG_KEY = (guildId) => `guild:${guildId}:autonick_roles`;
const DEPARTMENT_ROLE_IDS = new Set(["1557783753982480445","1557784202844446750","1557784505362677892","1557784711072579706","1557784915876257957","1557785136462831766","1557785381213311027","1558672931272269834"]);
const normalize = (items) => (Array.isArray(items) ? items : []).filter((x) => x && typeof x.roleId === 'string' && typeof x.prefix === 'string').map((x) => ({ roleId: x.roleId, prefix: x.prefix, priority: Number(x.priority) || 0 })).sort((a, b) => b.priority - a.priority);

export default {
  data: new SlashCommandBuilder().setName('autonick').setDescription('Configure automatic nickname prefixes for Barracks roles')
    .addSubcommand(s => s.setName('add').setDescription('Add a role nickname prefix').addRoleOption(o => o.setName('role').setDescription('Role to monitor').setRequired(true)).addStringOption(o => o.setName('prefix').setDescription('Nickname prefix, e.g. 👮|').setRequired(true).setMaxLength(12)).addIntegerOption(o => o.setName('priority').setDescription('Higher number wins').setRequired(true).setMinValue(1).setMaxValue(1000)))
    .addSubcommand(s => s.setName('edit').setDescription('Edit a configured role').addRoleOption(o => o.setName('role').setDescription('Configured role').setRequired(true)).addStringOption(o => o.setName('prefix').setDescription('New prefix').setMaxLength(12)).addIntegerOption(o => o.setName('priority').setDescription('New priority').setMinValue(1).setMaxValue(1000)))
    .addSubcommand(s => s.setName('remove').setDescription('Remove a role from AutoNick').addRoleOption(o => o.setName('role').setDescription('Configured role').setRequired(true)))
    .addSubcommand(s => s.setName('list').setDescription('List configured AutoNick roles')),
  async execute(interaction) {
    if (!interaction.inGuild()) return interaction.reply({ content: 'Use this command inside the Barracks server.', ephemeral: true });
    if (!process.env.GUILD_ID || interaction.guildId !== process.env.GUILD_ID) return interaction.reply({ content: 'AutoNick role settings are only available in Barracks.', ephemeral: true });
    if (!isBotOwner(interaction.user.id)) return interaction.reply({ content: 'Only the bot owner can manage AutoNick settings.', ephemeral: true });
    await InteractionHelper.safeDefer(interaction);
    const { guild, client } = interaction;
    const sub = interaction.options.getSubcommand();
    const storedEntries = normalize(await client.db.get(CONFIG_KEY(guild.id), []));
    const entries = storedEntries.filter((entry) => !DEPARTMENT_ROLE_IDS.has(entry.roleId));
    if (entries.length !== storedEntries.length) {
      await client.db.set(CONFIG_KEY(guild.id), entries);
    }
    const role = interaction.options.getRole('role');
    if (sub === 'add') {
      if (DEPARTMENT_ROLE_IDS.has(role.id)) return InteractionHelper.safeEditReply(interaction, { content: 'Departmental roles cannot be configured for AutoNick. Their department nickname prefix is handled automatically.' });
      const prefix = interaction.options.getString('prefix').trim();
      const priority = interaction.options.getInteger('priority');
      if (!prefix) return InteractionHelper.safeEditReply(interaction, { content: 'Prefix cannot be empty.' });
      if (role.id === guild.id || role.managed || role.position >= (guild.members.me?.roles.highest.position ?? 0)) return InteractionHelper.safeEditReply(interaction, { content: 'I cannot manage that role. Choose a normal role below my highest role.' });
      if (entries.some(x => x.roleId === role.id)) return InteractionHelper.safeEditReply(interaction, { content: `${role} is already configured. Use /autonick edit to change it.` });
      entries.push({ roleId: role.id, prefix, priority });
      await client.db.set(CONFIG_KEY(guild.id), normalize(entries));
      return InteractionHelper.safeEditReply(interaction, { content: `✅ Added ${role} with prefix **${prefix}** and priority **${priority}**.` });
    }
    if (sub === 'edit') {
      if (DEPARTMENT_ROLE_IDS.has(role.id)) return InteractionHelper.safeEditReply(interaction, { content: 'Departmental roles cannot be configured for AutoNick. Their department nickname prefix is handled automatically.' });
      const index = entries.findIndex(x => x.roleId === role.id);
      if (index < 0) return InteractionHelper.safeEditReply(interaction, { content: `${role} is not configured. Use /autonick add first.` });
      const prefix = interaction.options.getString('prefix');
      const priority = interaction.options.getInteger('priority');
      if (prefix === null && priority === null) return InteractionHelper.safeEditReply(interaction, { content: 'Provide a new prefix, priority, or both.' });
      if (prefix !== null) { if (!prefix.trim()) return InteractionHelper.safeEditReply(interaction, { content: 'Prefix cannot be empty.' }); entries[index].prefix = prefix.trim(); }
      if (priority !== null) entries[index].priority = priority;
      await client.db.set(CONFIG_KEY(guild.id), normalize(entries));
      return InteractionHelper.safeEditReply(interaction, { content: `✅ Updated ${role}: prefix **${entries[index].prefix}**, priority **${entries[index].priority}**.` });
    }
    if (sub === 'remove') {
      const updated = entries.filter(x => x.roleId !== role.id);
      if (updated.length === entries.length) return InteractionHelper.safeEditReply(interaction, { content: `${role} is not configured in AutoNick.` });
      await client.db.set(CONFIG_KEY(guild.id), updated);
      return InteractionHelper.safeEditReply(interaction, { content: `✅ Removed ${role} from AutoNick. Members will be recalculated the next time their roles change.` });
    }
    if (!entries.length) return InteractionHelper.safeEditReply(interaction, { content: 'No AutoNick roles configured. Use /autonick add first.' });
    const rows = entries.map((x, i) => `**${i + 1}.** ${guild.roles.cache.get(x.roleId) || `Deleted role (${x.roleId})`} — prefix **${x.prefix}** — priority **${x.priority}**`);
    return InteractionHelper.safeEditReply(interaction, { content: `**Barracks AutoNick Roles**\n${rows.join('\n')}\n\nHigher priority numbers take precedence.` });
  },
};