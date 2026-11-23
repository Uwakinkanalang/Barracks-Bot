import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { getNicknamePrefix } from '../Economy/nickname.js';
import { getEconomyData, setEconomyData } from '../../utils/economy.js';

export default {
  data: new SlashCommandBuilder()
    .setName('clan')
    .setDescription('Create and manage your clan')
    .addSubcommand(subcommand =>
      subcommand
        .setName('panel')
        .setDescription('Post the Create and Join Clan panel in the configured clan channel')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('leaderpanel')
        .setDescription('Post the separate Clan Leader and Vice Leader management panel')
        .addChannelOption(option => option.setName('channel').setDescription('Channel where the Leader Panel will be posted').addChannelTypes(ChannelType.GuildText).setRequired(true))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('memberpanel')
        .setDescription('Post the separate panel for approved clan members')
        .addChannelOption(option => option.setName('channel').setDescription('Channel where the Member Panel will be posted').addChannelTypes(ChannelType.GuildText).setRequired(true))
    )
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
      subcommand.setName('bank').setDescription('View your clan bank balance')
    )
    .addSubcommand(subcommand =>
      subcommand.setName('deposit')
        .setDescription('Deposit Bcash into your clan bank')
        .addStringOption(option => option.setName('amount').setDescription('Amount to deposit, or all').setRequired(true))
    )
    .addSubcommand(subcommand =>
      subcommand.setName('withdraw')
        .setDescription('Withdraw Bcash from your clan bank')
        .addStringOption(option => option.setName('amount').setDescription('Amount to withdraw, or all').setRequired(true))
    )
    .addSubcommand(subcommand =>
      subcommand.setName('transactions').setDescription('View your clan bank transaction history')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('leave')
        .setDescription('Leave the clan you currently belong to')
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

    if (subcommand === 'panel') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.editReply({ content: 'You need the **Manage Server** permission to post the Clan HQ panel.' });
      }

      const panelChannelId = '1559627423492874351';
      try {
        const panelChannel = await interaction.guild.channels.fetch(panelChannelId);
        if (!panelChannel?.isTextBased() || !panelChannel.send) {
          return interaction.editReply({ content: 'The configured Clan HQ channel is missing or is not a text channel. Please check the channel ID.' });
        }

        const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe();
        const permissions = panelChannel.permissionsFor(botMember);
        if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
          return interaction.editReply({ content: 'I am missing permissions in the configured Clan HQ channel. Please grant **View Channel**, **Send Messages**, and **Embed Links**.' });
        }

        const panelEmbed = new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle('⚔️ BARRACKS CLAN')
          .setDescription('Choose your path in the Barracks:\n\n**🏰 Create a Clan** — Build and lead your own squad. *(Fee: 5,000,000 bCash; staff approval required.)*\n**🛡️ Join a Clan** — Apply to join an approved squad.\n**🚪 Leave a Clan** — Leave your current squad. Clan Leaders must transfer leadership or disband their clan first.')
          .setImage('https://cdn.discordapp.com/attachments/1572883657440366673/1573781600288903338/Barracks_ng_Clan__Lumikha_o_Sumali.png?ex=6b0341d4&is=6b01f054&hm=facef902ae537aa1991ce3213bede46f9959e17e4e9998bae03980b016a160db&')
          .addFields({ name: '📜 Clan Guidelines', value: '• One clan per member.\n• Clan creation requires staff approval.\n• Join requests must be accepted by clan leadership.\n• Clan Leaders must transfer leadership or remove their clan before leaving.' })
          .setFooter({ text: 'Barracks • Clan Registry' });

        const panelRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('clan:create').setLabel('Create a Clan').setEmoji('🏰').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('clan:join:open').setLabel('Join a Clan').setEmoji('🛡️').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('clan:leave:open').setLabel('Leave a Clan').setEmoji('🚪').setStyle(ButtonStyle.Danger),
        );

        await panelChannel.send({ embeds: [panelEmbed], components: [panelRow] });
        return interaction.editReply({ content: `✅ Clan HQ panel posted in <#${panelChannelId}>.` });
      } catch (error) {
        logger.error('Failed to post Clan HQ panel:', { error: error.message, guildId: interaction.guildId, channelId: panelChannelId });
        return interaction.editReply({ content: 'I could not post the Clan HQ panel. Check the bot permissions and channel ID, then try again.' });
      }
    }

    if (subcommand === 'leaderpanel') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: 'You need the **Manage Server** permission to post the Clan Leader Panel.', flags: MessageFlags.Ephemeral });
      }
      const channel = interaction.options.getChannel('channel', true);
      if (!channel.isTextBased() || !channel.send) {
        return interaction.reply({ content: 'Choose a text channel where the bot can send messages.', flags: MessageFlags.Ephemeral });
      }
      const panelEmbed = new EmbedBuilder()
        .setColor(0xD4A017)
        .setTitle('👑 BARRACKS • CLAN LEADER PANEL')
        .setDescription('Your command post for managing your clan. Only the Clan Leader and Vice Clan Leader of an approved clan can use these controls.')
        .addFields(
          { name: '👥 Manage Members', value: 'View your clan roster.', inline: true },
          { name: '📜 Transactions', value: 'Review the latest bank activity.', inline: true },
          { name: '📨 Join Requests', value: 'Check pending applications.', inline: true },
          { name: '⚙️ Clan Settings', value: 'View your clan details and rules.', inline: true },
        )
        .setFooter({ text: 'Barracks • Leadership Command' });
      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('clan:leader:members').setLabel('View Members').setEmoji('👥').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('clan:leader:requests').setLabel('Join Requests').setEmoji('📨').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('clan:leader:settings').setLabel('Clan Details').setEmoji('⚙️').setStyle(ButtonStyle.Secondary)
      );
      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('clan:leader:transactions').setLabel('Transactions').setEmoji('📜').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('clan:leader:kickmember').setLabel('Remove Member').setEmoji('➖').setStyle(ButtonStyle.Danger)
      );
      await channel.send({ embeds: [panelEmbed], components: [row1, row2] });
      return interaction.reply({ content: `✅ Clan Leader Panel posted in <#${channel.id}>. Only your approved clan's Leader and Vice Leader can use it.`, flags: MessageFlags.Ephemeral });
    }

    if (subcommand === 'memberpanel') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: 'You need the **Manage Server** permission to post the Clan Member Panel.', flags: MessageFlags.Ephemeral });
      }
      const channel = interaction.options.getChannel('channel', true);
      if (!channel.isTextBased() || !channel.send) {
        return interaction.reply({ content: 'Choose a text channel where the bot can send messages.', flags: MessageFlags.Ephemeral });
      }
      const panelEmbed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🛡️ BARRACKS • CLAN MEMBER PANEL')
        .setDescription('Your squad information hub. Members of an approved clan can check their clan details, roster, rules, or leave their clan.')
        .addFields(
          { name: '🏰 Clan Details', value: 'View your clan information.', inline: true },
          { name: '👥 Clan Members', value: 'See who is in your squad.', inline: true },
          { name: '📜 Clan Rules', value: 'Review the rules of your squad.', inline: true }
        )
        .setFooter({ text: 'Barracks • Member Command Post' });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('clan:member:details').setLabel('Clan Details').setEmoji('🏰').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('clan:member:members').setLabel('Members').setEmoji('👥').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('clan:member:rules').setLabel('Clan Rules').setEmoji('📜').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('clan:leave:open').setLabel('Leave Clan').setEmoji('🚪').setStyle(ButtonStyle.Danger)
      );
      await channel.send({ embeds: [panelEmbed], components: [row] });
      return interaction.reply({ content: `✅ Clan Member Panel posted in <#${channel.id}>. Any member of an approved clan can use it.`, flags: MessageFlags.Ephemeral });
    }

    if (subcommand === 'leave') {
      const storageKey = `guild:${interaction.guildId}:clans`;
      const clanList = await interaction.client.db.get(storageKey, []);
      const clans = Array.isArray(clanList) ? clanList : [];
      const memberships = clans.filter(entry => entry.status === 'approved' &&
        entry.leaderId !== interaction.user.id &&
        (String(entry.viceLeaderId || '') === interaction.user.id ||
          (Array.isArray(entry.memberIds) && entry.memberIds.map(String).includes(interaction.user.id))));
      if (!memberships.length) {
        return interaction.reply({ content: 'You are not a member of an approved clan, or you are the Clan Leader. The Clan Leader must transfer leadership or delete the clan before leaving.', flags: MessageFlags.Ephemeral });
      }
      const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
      if (!member) return interaction.reply({ content: 'I could not find your server membership. Please try again.', flags: MessageFlags.Ephemeral });
      try {
        for (const clan of memberships) {
          if (clan.roleId && member.roles.cache.has(clan.roleId)) {
            await member.roles.remove(clan.roleId, `Left clan ${clan.name}`);
          }
        }
      } catch (error) {
        logger.warn(`Could not remove clan role from ${member.id}: ${error.message}`);
        return interaction.reply({ content: 'I could not remove your clan role. Please check the bot role hierarchy and try again; your clan membership has not been changed.', flags: MessageFlags.Ephemeral });
      }
      for (const clan of memberships) {
        clan.memberIds = (Array.isArray(clan.memberIds) ? clan.memberIds : []).filter(userId => String(userId) !== interaction.user.id);
        if (String(clan.viceLeaderId || '') === interaction.user.id) clan.viceLeaderId = null;
      }
      await interaction.client.db.set(storageKey, clans);
      let baseName = member.nickname || member.user.username;
      for (const clan of memberships) {
        const clanTagPrefix = `${clan.tag} `;
        if (baseName.startsWith(clanTagPrefix)) baseName = baseName.slice(clanTagPrefix.length).trim();
      }
      const prefix = await getNicknamePrefix(member, interaction.client, interaction.guildId);
      await member.setNickname(`${prefix}${baseName}`.slice(0, 32), 'Left Barracks clan').catch(() => {});
      const leftNames = memberships.map(clan => `**${clan.name} [${clan.tag}]**`).join(', ');
      return interaction.reply({ content: `✅ You have left ${leftNames}. Your clan role(s) and clan nickname tag(s) have been removed.`, flags: MessageFlags.Ephemeral });
    }

    if (['bank', 'deposit', 'withdraw', 'transactions'].includes(subcommand)) {
      const storageKey = `guild:${interaction.guildId}:clans`;
      const clans = await interaction.client.db.get(storageKey, []);
      const clanList = Array.isArray(clans) ? clans : [];
      const clan = clanList.find(entry =>
        entry.status === 'approved' &&
        (String(entry.leaderId) === interaction.user.id || String(entry.viceLeaderId || '') === interaction.user.id)
      );

      if (!clan) {
        return interaction.reply({ content: 'Only a **Clan Leader** or **Vice Clan Leader** can access and manage the Clan Bank.', flags: MessageFlags.Ephemeral });
      }

      clan.bankBalance = Math.max(0, Number(clan.bankBalance) || 0);
      clan.bankTransactions = Array.isArray(clan.bankTransactions) ? clan.bankTransactions : [];

      if (subcommand === 'bank') {
        const embed = new EmbedBuilder()
          .setColor(Number.parseInt((clan.roleHex || '#5865F2').replace('#', ''), 16))
          .setTitle(`🏦 ${clan.name} [${clan.tag}] — Clan Bank`)
          .setDescription(`**Available Funds**\n₱${clan.bankBalance.toLocaleString()}\n\nOnly the Clan Leader and Vice Clan Leader can manage this treasury.`)
          .setFooter({ text: 'Barracks • Clan Treasury' });
        await interaction.client.db.set(storageKey, clanList);
        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }

      if (subcommand === 'transactions') {
        const recent = clan.bankTransactions.slice(-10).reverse();
        const lines = recent.map(tx => {
          const icon = tx.type === 'deposit' ? '📥' : '📤';
          const date = tx.createdAt ? new Date(tx.createdAt).toLocaleString() : 'Unknown date';
          return `${icon} **₱${Number(tx.amount || 0).toLocaleString()}** — ${tx.type} by <@${tx.userId}> • ${date}`;
        });
        const embed = new EmbedBuilder()
          .setColor(Number.parseInt((clan.roleHex || '#5865F2').replace('#', ''), 16))
          .setTitle(`📜 ${clan.name} — Bank Transactions`)
          .setDescription(lines.length ? lines.join('\n') : 'No transactions recorded yet.')
          .setFooter({ text: 'Showing the latest 10 transactions' });
        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }

      const amountInput = interaction.options.getString('amount', true).trim().toLowerCase();
      const userData = await getEconomyData(interaction.client, interaction.guildId, interaction.user.id);
      if (!userData) {
        return interaction.reply({ content: 'Could not load your Bcash account. Please try again.', flags: MessageFlags.Ephemeral });
      }

      const amount = amountInput === 'all'
        ? (subcommand === 'deposit' ? Number(userData.wallet) || 0 : clan.bankBalance)
        : Number(amountInput);
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        return interaction.reply({ content: 'Enter a valid whole-number amount greater than 0, or use `all`.', flags: MessageFlags.Ephemeral });
      }

      if (subcommand === 'deposit') {
        if (amount > (Number(userData.wallet) || 0)) {
          return interaction.reply({ content: 'You do not have enough Bcash in your wallet.', flags: MessageFlags.Ephemeral });
        }
        userData.wallet -= amount;
        clan.bankBalance += amount;
      } else {
        if (amount > clan.bankBalance) {
          return interaction.reply({ content: 'The Clan Bank does not have enough funds for that withdrawal.', flags: MessageFlags.Ephemeral });
        }
        userData.wallet = (Number(userData.wallet) || 0) + amount;
        clan.bankBalance -= amount;
      }

      await setEconomyData(interaction.client, interaction.guildId, interaction.user.id, userData);
      clan.bankTransactions.push({ type: subcommand, amount, userId: interaction.user.id, createdAt: Date.now() });
      clan.bankTransactions = clan.bankTransactions.slice(-100);
      await interaction.client.db.set(storageKey, clanList);

      return interaction.reply({
        content: `✅ ${subcommand === 'deposit' ? 'Deposited' : 'Withdrew'} **₱${amount.toLocaleString()}** ${subcommand === 'deposit' ? 'into' : 'from'} **${clan.name} [${clan.tag}] Clan Bank**.\n🏦 Clan Bank balance: **₱${clan.bankBalance.toLocaleString()}**\n💵 Your wallet: **₱${(Number(userData.wallet) || 0).toLocaleString()}**`,
        flags: MessageFlags.Ephemeral,
      });
    }

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
          .setDescription(roster.join('\n'))
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
        if (memberIds.length + 2 >= Math.max(10, Number(clan.maxMembers) || 10)) {
          return interaction.reply({ content: `Your clan has reached its current capacity of ${Math.max(10, Number(clan.maxMembers) || 10)} members (including leadership). Purchase another Clan Member Expansion in the Clan Shop to add 10 more slots, up to 200.`, flags: MessageFlags.Ephemeral });
        }
        clan.memberIds = [...memberIds, target.id];
        await interaction.client.db.set(storageKey, clanList);
        if (clan.status === 'approved' && clan.roleId) {
          const clanRole = await interaction.guild.roles.fetch(clan.roleId).catch(() => null);
          if (clanRole) {
            await targetMember.roles.add(clanRole, `Added to clan ${clan.name}`);
          }
        }
        return interaction.reply({
          content: `✅ <@${target.id}> has been added to **${clan.name} [${clan.tag}]**. Their clan role and nickname will sync automatically.`,
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
      const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
      if (targetMember && clan.roleId) {
        await targetMember.roles.remove(clan.roleId, `Removed from clan ${clan.name}`).catch(() => {});
      }
      if (targetMember) {
        const currentName = targetMember.nickname || targetMember.user.username;
        const clanTagPrefix = `${clan.tag} `;
        const baseName = currentName.startsWith(clanTagPrefix) ? currentName.slice(clanTagPrefix.length).trim() : currentName;
        const prefix = await getNicknamePrefix(targetMember, interaction.client, interaction.guildId);
        await targetMember.setNickname(`${prefix}${baseName}`.slice(0, 32), `Removed from clan ${clan.name}`).catch(() => {});
      }
      return interaction.reply({
        content: `🗑️ <@${target.id}> has been removed from **${clan.name} [${clan.tag}]**. Their clan tag has been removed from their nickname.`,
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
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('clan:join:open')
        .setLabel('Join a Clan')
        .setEmoji('🛡️')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('clan:leave:open')
        .setLabel('Leave a Clan')
        .setEmoji('🚪')
        .setStyle(ButtonStyle.Danger)
    );

    await interaction.reply({ embeds: [embed], components: [row] });
  },
};
