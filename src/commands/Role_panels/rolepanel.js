import {
  SlashCommandBuilder, MessageFlags, PermissionFlagsBits,
  ContainerBuilder, SectionBuilder, TextDisplayBuilder, ButtonBuilder, ButtonStyle,
} from 'discord.js';

const ROLES_KEY = guildId => `guild:${guildId}:rolePanelRoles`;
const PANEL_KEY = guildId => `guild:${guildId}:rolePanelMessage`;
const MAX_ROLES = 12;

function staffRoleIds(config = {}) {
  const values = [
    ...(Array.isArray(config.staffRoleIds) ? config.staffRoleIds : []),
    ...(Array.isArray(config.staffRoles) ? config.staffRoles : []),
    config.adminRole, config.modRole,
  ];
  return [...new Set(values.map(value => typeof value === 'object' ? value?.id : value).filter(Boolean).map(String))];
}

function buildRolePanel(guildId, roles) {
  const container = new ContainerBuilder()
    .setAccentColor(0x5865F2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('## Pick your roles'))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('Press **Get / Remove** beside a role to add it, and again to take it off. Only you see the answer.'));

  for (const item of roles) {
    const roleId = String(item.role);
    const emoji = item.emoji ? `${item.emoji} ` : '';
    const description = String(item.description || '').trim();
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${emoji}<@&${roleId}>**${description ? `\\n${description}` : ''}`))
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId(`rolepanel:toggle:${guildId}:${roleId}`)
            .setLabel('Get / Remove')
            .setStyle(ButtonStyle.Secondary)
        )
    );
  }
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

export default {
  data: new SlashCommandBuilder()
    .setName('rolepanel')
    .setDescription('Post or update the self-assignable role panel'),
  async execute(interaction, guildConfig, client) {
    if (!interaction.guild) {
      return interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
    }
    const allowedRoles = staffRoleIds(guildConfig);
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!allowedRoles.length || !allowedRoles.some(id => member.roles.cache.has(id))) {
      return interaction.reply({ content: 'Only members with a configured staff role can use /rolepanel.', flags: MessageFlags.Ephemeral });
    }

    const roles = await client.db.get(ROLES_KEY(interaction.guildId), []);
    if (!Array.isArray(roles) || roles.length === 0) {
      return interaction.reply({ content: 'No roles are configured. Add entries to the rolePanelRoles list setting first.', flags: MessageFlags.Ephemeral });
    }
    if (roles.length > MAX_ROLES) {
      return interaction.reply({ content: `The rolePanelRoles setting can contain at most ${MAX_ROLES} roles.`, flags: MessageFlags.Ephemeral });
    }

    const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe();
    if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return interaction.reply({ content: 'I need the Manage Roles permission to publish and operate this panel.', flags: MessageFlags.Ephemeral });
    }
    for (const item of roles) {
      const roleId = String(item?.role || '');
      const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
      if (!role || role.id === interaction.guildId || role.managed || role.position >= botMember.roles.highest.position) {
        return interaction.reply({ content: `The configured role ${roleId ? `<@&${roleId}>` : '(missing role)'} is unavailable or above my highest role.`, flags: MessageFlags.Ephemeral });
      }
      if (typeof item.description !== 'string' || item.description.length > 200 || typeof item.emoji !== 'string') {
        return interaction.reply({ content: 'Each role setting must include a role ID, emoji string, and description (200 characters maximum).', flags: MessageFlags.Ephemeral });
      }
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const payload = buildRolePanel(interaction.guildId, roles);
    const saved = await client.db.get(PANEL_KEY(interaction.guildId), null);
    let message = null;
    if (saved?.channelId && saved?.messageId) {
      const channel = await interaction.guild.channels.fetch(saved.channelId).catch(() => null);
      message = await channel?.messages.fetch(saved.messageId).catch(() => null);
    }
    if (message) {
      await message.edit(payload);
      return interaction.editReply(`✅ Role panel updated: ${message.url}`);
    }

    message = await interaction.channel.send(payload);
    await client.db.set(PANEL_KEY(interaction.guildId), { channelId: message.channelId, messageId: message.id });
    return interaction.editReply(`✅ Role panel posted: ${message.url}`);
  },
};
