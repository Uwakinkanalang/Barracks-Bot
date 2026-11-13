import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits, MessageFlags } from 'discord.js';

export default {
  data: new SlashCommandBuilder()
    .setName('clan')
    .setDescription('Create and manage your clan')
    .addSubcommand(subcommand =>
      subcommand
        .setName('setapproverole')
        .setDescription('Set the role allowed to approve or reject clan registrations')
        .addRoleOption(option =>
          option.setName('role').setDescription('Clan registration approver role').setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('setlogchannel')
        .setDescription('Set the channel where new clan registrations are sent')
        .addChannelOption(option =>
          option
            .setName('channel')
            .setDescription('Staff channel for clan registration notifications')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('addmember')
        .setDescription('Add a member to your clan roster')
        .addUserOption(option =>
          option.setName('user').setDescription('Member to add').setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('kick')
        .setDescription('Remove a member from your clan roster')
        .addUserOption(option =>
          option.setName('user').setDescription('Member to remove').setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('members')
        .setDescription('View your clan membership roster')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('delete')
        .setDescription('Remove the clan you lead')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('remove')
        .setDescription('Remove the clan you lead')
    ),

  category: 'Community',

  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
    }

    const subcommand = interaction.options.getSubcommand();

    if (['addmember', 'kick', 'members'].includes(subcommand)) {
      const storageKey = `guild:${interaction.guildId}:clans`;
      const clans = await interaction.client.db.get(storageKey, []);
      const clanList = Array.isArray(clans) ? clans : [];
      const clan = clanList.find(entry =>
        entry.leaderId === interaction.user.id ||
        entry.viceLeaderId === interaction.user.id ||
        (Array.isArray(entry.memberIds) && entry.memberIds.includes(interaction.user.id))
      );

      if (!clan) {
        return interaction.reply({
          content: 'You are not listed in a registered clan.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const memberIds = Array.isArray(clan.memberIds) ? clan.memberIds : [];
      const isLeader = clan.leaderId === interaction.user.id;
      const isViceLeader = clan.viceLeaderId === interaction.user.id;
      const canManage = isLeader || isViceLeader;

      if (subcommand === 'members') {
        const roster = [
          `👑 **Clan Leader:** <@${clan.leaderId}>`,
          `🛡️ **Vice Clan Leader:** <@${clan.viceLeaderId}>`,
          ...memberIds.map(userId => `• <@${userId}>`),
        ];
        const rosterEmbed = new EmbedBuilder()
          .setColor(Number.parseInt((clan.roleHex || '#5865F2').replace('#', ''), 16))
          .setTitle(`🏰 ${clan.name} [${clan.tag}] — Members`)
          .setDescription(roster.join('\\n'))
          .setFooter({ text: `Total roster: ${memberIds.length + 2} • Barracks Clan Registry` });
        return interaction.reply({ embeds: [rosterEmbed], flags: MessageFlags.Ephemeral });
      }

      if (!canManage) {
        return interaction.reply({
          content: 'Only your Clan Leader or Vice Clan Leader can manage the clan roster.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const target = interaction.options.getUser('user', true);
      if (target.bot) {
        return interaction.reply({ content: 'Bots cannot be added to a clan roster.', flags: MessageFlags.Ephemeral });
      }
      if (target.id === clan.leaderId || target.id === clan.viceLeaderId) {
        return interaction.reply({ content: 'Clan leadership cannot be added or removed through member management.', flags: MessageFlags.Ephemeral });
      }

      if (subcommand === 'addmember') {
        const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
        if (!targetMember) {
          return interaction.reply({ content: 'That user is not a member of this server.', flags: MessageFlags.Ephemeral });
        }
        const alreadyInClan = clanList.find(entry =>
          entry.leaderId === target.id ||
          entry.viceLeaderId === target.id ||
          (Array.isArray(entry.memberIds) && entry.memberIds.includes(target.id))
        );
        if (alreadyInClan) {
          return interaction.reply({
            content: alreadyInClan.id === clan.id
              ? `<@${target.id}> is already in your clan roster.`
              : `<@${target.id}> already belongs to another registered clan.`,
            flags: MessageFlags.Ephemeral,
          });
        }
        if (memberIds.length >= 50) {
          return interaction.reply({ content: 'Your clan roster has reached the 50-member limit.', flags: MessageFlags.Ephemeral });
        }
        clan.memberIds = [...memberIds, target.id];
        await interaction.client.db.set(storageKey, clanList);
        return interaction.reply({
          content: `✅ <@${target.id}> has been added to **${clan.name} [${clan.tag}]**.`,
          allowedMentions: { users: [target.id] },
        });
      }

      if (!memberIds.includes(target.id)) {
        return interaction.reply({
          content: `<@${target.id}> is not a regular member of **${clan.name} [${clan.tag}]**.`,
          flags: MessageFlags.Ephemeral,
        });
      }
      clan.memberIds = memberIds.filter(userId => userId !== target.id);
      await interaction.client.db.set(storageKey, clanList);
      return interaction.reply({
        content: `🗑️ <@${target.id}> has been removed from **${clan.name} [${clan.tag}]**.`,
        allowedMentions: { users: [target.id] },
      });
    }

    if (subcommand === 'delete' || subcommand === 'remove') {
      const clans = await interaction.client.db.get(`guild:${interaction.guildId}:clans`, []);
      const clanList = Array.isArray(clans) ? clans : [];
      const clan = clanList.find(entry => entry.leaderId === interaction.user.id);

      if (!clan) {
        return interaction.reply({
          content: 'You do not currently lead a registered clan.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const confirmEmbed = new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle('⚠️ Confirm Clan Removal')
        .setDescription(
          `Are you sure you want to permanently remove **${clan.name} [${clan.tag}]**?\n\n` +
          'This will remove its registration from the Barracks clan registry. This action cannot be undone.'
        )
        .setFooter({ text: 'Only the Clan Leader can remove this clan.' });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`clan:delete:confirm:${interaction.user.id}`)
          .setLabel('Yes, Remove My Clan')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`clan:delete:cancel:${interaction.user.id}`)
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary),
      );

      return interaction.reply({
        embeds: [confirmEmbed],
        components: [row],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (subcommand === 'setapproverole') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({
          content: 'You need the **Manage Server** permission to configure the clan approval role.',
          flags: MessageFlags.Ephemeral,
        });
      }
      const role = interaction.options.getRole('role', true);
      await interaction.client.db.set(`guild:${interaction.guildId}:clan_approval_role`, role.id);
      return interaction.reply({
        content: `✅ ${role} can now approve or reject clan registrations.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (subcommand === 'setlogchannel') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({
          content: 'You need the **Manage Server** permission to configure the clan log channel.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const channel = interaction.options.getChannel('channel', true);
      await interaction.client.db.set(`guild:${interaction.guildId}:clan_log_channel`, channel.id);
      return interaction.reply({
        content: `New clan registrations will now be sent to ${channel}.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('🏰 BARRACKS CLAN REGISTRATION')
      .setDescription(
        'Ready to lead your own squad? Create a clan and bring your soldiers together!\n\n' +
        '**Information required**\n' +
        '• Clan Name\n' +
        '• Clan Tag + Role Hex (example: ABC | #5865F2)\n' +
        '• Clan Description\n' +
        '• Vice Clan Leader\n' +
        '• Clan Logo Upload (optional image attachment)\n\n' +
        'Your account will automatically be registered as the **Clan Leader**.'
      )
      .setFooter({ text: 'Barracks • Clan Registry' });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('clan:create')
        .setLabel('Create a Clan')
        .setEmoji('🏰')
        .setStyle(ButtonStyle.Primary)
    );

    await interaction.reply({ embeds: [embed], components: [row] });
  },
};
