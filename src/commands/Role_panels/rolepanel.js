import {
  SlashCommandBuilder, MessageFlags, PermissionFlagsBits,
  ContainerBuilder, SectionBuilder, TextDisplayBuilder, ButtonBuilder, ButtonStyle,
} from 'discord.js';

const ROLES_KEY = guildId => `guild:${guildId}:rolePanelRoles`;
const STAFF_KEY = guildId => `guild:${guildId}:rolePanelStaffRoles`;
const PANEL_KEY = guildId => `guild:${guildId}:rolePanelMessage`;
const MAX_ROLES = 12;

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
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${emoji}<@&${roleId}>**${description ? `\n${description}` : ''}`))
        .setButtonAccessory(new ButtonBuilder()
          .setCustomId(`rolepanel:toggle:${guildId}:${roleId}`)
          .setLabel('Get / Remove')
          .setStyle(ButtonStyle.Secondary))
    );
  }
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

async function isOwner(interaction) {
  return interaction.user.id === interaction.guild.ownerId;
}

export default {
  data: new SlashCommandBuilder()
    .setName('rolepanel')
    .setDescription('Configure and publish the self-assignable role panel')
    .addSubcommand(sub => sub.setName('add').setDescription('Add or update a role in the panel')
      .addRoleOption(option => option.setName('role').setDescription('Role to display').setRequired(true))
      .addStringOption(option => option.setName('emoji').setDescription('Emoji shown beside the role').setRequired(true))
      .addStringOption(option => option.setName('description').setDescription('Short role description').setMaxLength(200).setRequired(true)))
    .addSubcommand(sub => sub.setName('remove').setDescription('Remove a role from the panel')
      .addRoleOption(option => option.setName('role').setDescription('Role to remove').setRequired(true)))
    .addSubcommand(sub => sub.setName('list').setDescription('View the configured panel roles'))
    .addSubcommand(sub => sub.setName('staff-add').setDescription('Allow a staff role to publish or update the panel')
      .addRoleOption(option => option.setName('role').setDescription('Staff role to authorize').setRequired(true)))
    .addSubcommand(sub => sub.setName('staff-remove').setDescription('Remove a staff role authorization')
      .addRoleOption(option => option.setName('role').setDescription('Staff role to remove').setRequired(true)))
    .addSubcommand(sub => sub.setName('staff-list').setDescription('View authorized staff roles')),

  async execute(interaction, guildConfig, client) {
    if (!interaction.guild) {
      return interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
    }

    const subcommand = interaction.options.getSubcommand(false);
    const guildId = interaction.guildId;

    // Configuration is intentionally server-owner-only, matching B-Shop management.
    if (subcommand) {
      if (!(await isOwner(interaction))) {
        return interaction.reply({ content: '❌ Only the **server owner** can configure the role panel.', flags: MessageFlags.Ephemeral });
      }

      if (subcommand === 'add') {
        const role = interaction.options.getRole('role', true);
        const emoji = interaction.options.getString('emoji', true).trim();
        const description = interaction.options.getString('description', true).trim();
        const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe();
        if (role.id === guildId || role.managed || role.position >= botMember.roles.highest.position) {
          return interaction.reply({ content: 'That role cannot be self-assigned. Choose a normal role below my highest role.', flags: MessageFlags.Ephemeral });
        }
        const roles = await client.db.get(ROLES_KEY(guildId), []);
        const existingIndex = roles.findIndex(item => String(item.role) === role.id);
        if (existingIndex < 0 && roles.length >= MAX_ROLES) {
          return interaction.reply({ content: `The role panel is limited to ${MAX_ROLES} roles. Remove one before adding another.`, flags: MessageFlags.Ephemeral });
        }
        const entry = { role: role.id, emoji, description };
        if (existingIndex >= 0) roles[existingIndex] = entry;
        else roles.push(entry);
        await client.db.set(ROLES_KEY(guildId), roles);
        return interaction.reply({ content: `✅ ${role} ${existingIndex >= 0 ? 'was updated' : 'was added'} to the role panel. Run /rolepanel to publish the changes.`, flags: MessageFlags.Ephemeral });
      }

      if (subcommand === 'remove') {
        const role = interaction.options.getRole('role', true);
        const roles = await client.db.get(ROLES_KEY(guildId), []);
        const next = roles.filter(item => String(item.role) !== role.id);
        if (next.length === roles.length) {
          return interaction.reply({ content: `${role} is not in the role panel.`, flags: MessageFlags.Ephemeral });
        }
        await client.db.set(ROLES_KEY(guildId), next);
        return interaction.reply({ content: `✅ Removed ${role} from the role panel. Run /rolepanel to update the posted panel.`, flags: MessageFlags.Ephemeral });
      }

      if (subcommand === 'list') {
        const roles = await client.db.get(ROLES_KEY(guildId), []);
        const content = roles.length
          ? roles.map((item, index) => `${index + 1}. ${item.emoji || ''} <@&${item.role}> — ${item.description}`).join('\n')
          : 'No roles have been added yet. Use `/rolepanel add` to add one.';
        return interaction.reply({ content: `**Role Panel — ${roles.length}/${MAX_ROLES}**\n${content}`, flags: MessageFlags.Ephemeral });
      }

      if (subcommand === 'staff-add') {
        const role = interaction.options.getRole('role', true);
        const staffRoles = await client.db.get(STAFF_KEY(guildId), []);
        if (staffRoles.includes(role.id)) {
          return interaction.reply({ content: `${role} is already authorized to manage the role panel.`, flags: MessageFlags.Ephemeral });
        }
        staffRoles.push(role.id);
        await client.db.set(STAFF_KEY(guildId), staffRoles);
        return interaction.reply({ content: `✅ ${role} can now use /rolepanel to publish or update the panel.`, flags: MessageFlags.Ephemeral });
      }

      if (subcommand === 'staff-remove') {
        const role = interaction.options.getRole('role', true);
        const staffRoles = await client.db.get(STAFF_KEY(guildId), []);
        const next = staffRoles.filter(id => id !== role.id);
        if (next.length === staffRoles.length) {
          return interaction.reply({ content: `${role} is not an authorized staff role.`, flags: MessageFlags.Ephemeral });
        }
        await client.db.set(STAFF_KEY(guildId), next);
        return interaction.reply({ content: `✅ Removed ${role} from the authorized staff list.`, flags: MessageFlags.Ephemeral });
      }

      if (subcommand === 'staff-list') {
        const staffRoles = await client.db.get(STAFF_KEY(guildId), []);
        const content = staffRoles.length ? staffRoles.map(id => `• <@&${id}>`).join('\n') : 'No staff roles configured. Only the server owner can publish the panel until a staff role is added.';
        return interaction.reply({ content: `**Role Panel Staff Roles**\n${content}`, flags: MessageFlags.Ephemeral });
      }
      return;
    }

    const staffRoles = await client.db.get(STAFF_KEY(guildId), []);
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!Array.isArray(staffRoles) || !staffRoles.some(id => member.roles.cache.has(id))) {
      return interaction.reply({ content: 'Only members with a configured staff role can publish or update the role panel.', flags: MessageFlags.Ephemeral });
    }

    const roles = await client.db.get(ROLES_KEY(guildId), []);
    if (!Array.isArray(roles) || roles.length === 0) {
      return interaction.reply({ content: 'No roles configured. Use `/rolepanel add` to add roles first.', flags: MessageFlags.Ephemeral });
    }
    if (roles.length > MAX_ROLES) {
      return interaction.reply({ content: `The role panel is limited to ${MAX_ROLES} roles.`, flags: MessageFlags.Ephemeral });
    }

    const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe();
    if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return interaction.reply({ content: 'I need the Manage Roles permission to publish and operate this panel.', flags: MessageFlags.Ephemeral });
    }
    for (const item of roles) {
      const roleId = String(item?.role || '');
      const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
      if (!role || role.id === guildId || role.managed || role.position >= botMember.roles.highest.position) {
        return interaction.reply({ content: `The configured role ${roleId ? `<@&${roleId}>` : '(missing role)'} is unavailable or above my highest role.`, flags: MessageFlags.Ephemeral });
      }
      if (typeof item.description !== 'string' || item.description.length > 200 || typeof item.emoji !== 'string') {
        return interaction.reply({ content: 'Each role needs an emoji and a description of 200 characters or fewer.', flags: MessageFlags.Ephemeral });
      }
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const payload = buildRolePanel(guildId, roles);
    const saved = await client.db.get(PANEL_KEY(guildId), null);
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
    await client.db.set(PANEL_KEY(guildId), { channelId: message.channelId, messageId: message.id });
    return interaction.editReply(`✅ Role panel posted: ${message.url}`);
  },
};
