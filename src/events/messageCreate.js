import { EmbedBuilder, Events, MessageFlags } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getLevelingConfig, getUserLevelData } from '../services/leveling/leveling.js';
import { addXp } from '../services/leveling/xpSystem.js';
import { checkRateLimit } from '../utils/rateLimiter.js';
import { parsePrefixCommand } from '../utils/prefixParser.js';
import { getWelcomeConfig } from '../utils/database.js';
import { buildWelcomeCard } from './guildMemberAdd.js';
import { AttachmentBuilder, PermissionFlagsBits } from 'discord.js';
import { supportsPrefixExecution, executePrefixCommand, resolvePrefixAccessKey } from '../utils/messageAdapter.js';
import { resolveCommandAlias, resolveSubcommandAlias } from '../config/commands/commandAliases.js';
import { getPrefixRestriction } from '../config/commands/prefixRestrictions.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { getCommandPrefix, getBotMessage, isBotOwner, isCommandCategoryEnabled, isMaintenanceMode } from '../config/bot.js';
import { enforceAbuseProtection, formatCooldownDuration } from '../utils/abuseProtection.js';
import { createEmbed } from '../utils/embeds.js';
import { isCommandEnabled } from '../services/commandAccessService.js';
import { getItems as getBShopItems, getColorItems as getBShopColorItems, getBoosterColorItems as getBShopBoosterColorItems, buildShopPage as buildBShopPage, buildColorShopPage as buildBShopColorPage, buildBoosterColorShopPage as buildBShopBoosterColorPage } from '../commands/Economy/roleshop.js';
import { handleClanShopPrefixCommand } from '../commands/Economy/clanshop.js';
import {
  getCountingGameConfig,
  saveCountingGameConfig,
  isValidCountingMessage,
  recordCorrectCount,
} from '../services/countingGameService.js';

const MESSAGE_XP_RATE_LIMIT_ATTEMPTS = 12;
const MESSAGE_XP_RATE_LIMIT_WINDOW_MS = 10000;

export default {
  name: Events.MessageCreate,
  async execute(message, client) {
    try {
      if (message.author.bot || !message.guild) return;

      logger.debug(`Message received from ${message.author.tag}: ${message.content}`);

      const countingProcessed = await handleCountingGame(message, client);
      if (countingProcessed) {
        return;
      }

      await handlePrefixCommand(message, client);

      await handleLeveling(message, client);
    } catch (error) {
      logger.error('Error in messageCreate event:', error);
    }
  }
};

async function handlePrefixCommand(message, client) {
  try {
    const guildConfig = await getGuildConfig(client, message.guild.id);
    const prefix = guildConfig?.prefix || getCommandPrefix();

    const trimmedContent = message.content.trim();

    // Manual welcome banner preview: b!welcomebanner test
    if (/^b!welcomebanner\s+test$/i.test(trimmedContent)) {
      const canTestWelcomeBanner =
        message.member?.permissions?.has(PermissionFlagsBits.ManageGuild) ||
        message.member?.roles?.cache?.has('1557784202844446750');
      if (!canTestWelcomeBanner) {
        await message.reply('❌ You need **Manage Server** permission or the authorized staff role to test the welcome banner.');
        return;
      }

      const welcomeConfig = await getWelcomeConfig(client, message.guild.id);
      const backgroundUrl = welcomeConfig?.welcomeImage || welcomeConfig?.welcomeEmbed?.image?.url;
      if (!welcomeConfig?.enabled || !welcomeConfig?.channelId) {
        await message.reply('❌ Welcome is not enabled yet. Configure it first in **/greet dashboard**.');
        return;
      }
      if (!backgroundUrl) {
        await message.reply('❌ No Welcome Image is configured. Upload your camouflage background in **/greet dashboard → Welcome Image**, save it, then try again.');
        return;
      }

      try {
        const testMember = message.member || await message.guild.members.fetch(message.author.id);
        const card = await buildWelcomeCard(testMember, backgroundUrl, message.guild.memberCount);
        const attachment = new AttachmentBuilder(card, { name: 'barracks-welcome-card.svg' });
        await message.channel.send({
          content: `🪖 Welcome banner test for ${message.author} — this is a preview only; it does not change the member count or trigger a real join.`,
          files: [attachment],
          allowedMentions: { users: [message.author.id] },
        });
      } catch (error) {
        logger.error('Welcome banner test failed:', error);
        await message.reply(`❌ Welcome banner test failed: ${error.message || 'Could not render the card.'}`);
      }
      return;
    }

    // Barracks boost announcement test (direct handler; independent of command registry).
    if (/^b!booster\s+test$/i.test(trimmedContent)) {
      const hasAccess = message.member?.permissions?.has(PermissionFlagsBits.ManageGuild) || message.member?.roles?.cache?.has('1557784202844446750');
      if (!hasAccess) { await message.reply('❌ You need **Manage Server** permission to use this command.'); return; }
      const boostChannelId = '1572841358270402673';
      const bannerUrl = 'https://cdn.discordapp.com/attachments/1572883657440366673/1572920805241790545/Salamat_Sundalo_Barracks_Boost_Banner.png?ex=6b002027&is=6afecea7&hm=398065df88e897f01aa44b531da036e5d9816656112d2baa5350fa5c07c05f75';
      const boostChannel = await message.guild.channels.fetch(boostChannelId).catch(() => null);
      if (!boostChannel?.isTextBased() || !boostChannel.send) { await message.reply('❌ I could not find the configured boost announcement channel.'); return; }
      const testEmbed = new EmbedBuilder().setColor(0xD6A632)
         .setTitle(`${message.member?.displayName || message.author.globalName || message.author.username} boosted the server!`)
        .setDescription(`Your support helps our Barracks grow stronger.\nWe appreciate your contribution, soldier!`)
        .setThumbnail(message.member.displayAvatarURL({ size: 256 }))
        .setImage(bannerUrl).setFooter({ text: 'BARRACKS • THANK YOU FOR YOUR SUPPORT!' }).setTimestamp();
      await boostChannel.send({ embeds: [testEmbed], allowedMentions: { users: [message.author.id] } });
      await message.reply('✅ Test boost announcement sent to <#' + boostChannelId + '>.');
      return;
    }
    // Math challenge prefix command: b!math [easy|hard|random|add|subtract|multiply|divide]
    // Route it explicitly so the game works even if generic prefix parsing changes.
    const mathMatch = trimmedContent.match(/^b!math(?:\s+(easy|hard|random|add|subtract|multiply|divide))?$/i);
    if (mathMatch) {
      const mathCommand = client.commands.get('math');
      if (!mathCommand) {
        logger.error('Math command is not loaded.');
        await message.reply('❌ The Math Challenge is temporarily unavailable. Please contact an administrator.');
        return;
      }
      await executePrefixCommand(
        mathCommand,
        message,
        mathMatch[1] ? [mathMatch[1].toLowerCase()] : [],
        client,
        prefix,
        guildConfig,
      );
      return;
    }

    // Bank Upgrade panel prefix command: b!bankpanel upgrade
    if (/^b!bankpanel\s+upgrade$/i.test(trimmedContent)) {
      const bankUpgradeCommand = client.commands.get('bankupgrade');
      const hasBankPanelAccess = message.member?.permissions?.has('ManageGuild') || message.member?.roles?.cache?.has('1557784202844446750');
      if (!hasBankPanelAccess) {
        await message.reply('❌ You need **Manage Server** permission to post the Bank Upgrade Panel.');
        return;
      }
      if (!bankUpgradeCommand?.prefixExecute) {
        logger.error('Bank Upgrade panel command is not loaded.');
        await message.reply('❌ The Bank Upgrade Panel command is unavailable. Please contact an administrator.');
        return;
      }
      await bankUpgradeCommand.prefixExecute({
        guildId: message.guild.id,
        guild: message.guild,
        channel: message.channel,
        member: message.member,
        user: message.author,
        reply: payload => message.reply(payload),
      }, guildConfig, client);
      return;
    }

    // Standalone Clan Shop panel and owner-only text management commands.
    if (await handleClanShopPrefixCommand(message, client)) return;

    // Clan Shop public panel command.
    if (await handleClanShopPrefixCommand(message, client)) return;

    // Plain-text publisher: type "brole panel" (not a slash command).
    if (/^brole\s+panel$/i.test(trimmedContent)) {
      const staffRoles = await client.db.get(`guild:${message.guild.id}:rolePanelStaffRoles`, []);
      if (!Array.isArray(staffRoles) || !staffRoles.some(id => message.member?.roles?.cache?.has(id))) {
        await message.reply('❌ Only members with a configured role-panel staff role can publish or update this panel.');
        return;
      }
      const roles = await client.db.get(`guild:${message.guild.id}:rolePanelRoles`, []);
      if (!Array.isArray(roles) || roles.length === 0 || roles.length > 12) {
        await message.reply('❌ Configure between 1 and 12 roles first using /rolepanel add.');
        return;
      }
      const { ContainerBuilder, SectionBuilder, TextDisplayBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = await import('discord.js');
      const botMember = message.guild.members.me || await message.guild.members.fetchMe();
      if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
        await message.reply('❌ I need Manage Roles permission to publish and operate this panel.');
        return;
      }
      for (const item of roles) {
        const role = await message.guild.roles.fetch(String(item?.role || '')).catch(() => null);
        if (!role || role.id === message.guild.id || role.managed || role.position >= botMember.roles.highest.position ||
            role.permissions.toArray().some(permission => ['Administrator','ManageGuild','ManageRoles','BanMembers','KickMembers','ManageChannels','ManageWebhooks','MentionEveryone'].includes(permission))) {
          await message.reply(`❌ The configured role ${item?.role ? `<@&${item.role}>` : '(missing role)'} cannot be self-assigned or is above my highest role.`);
          return;
        }
      }
      const container = new ContainerBuilder().setAccentColor(0x5865F2)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('## Pick your roles'))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('Press **Get / Remove** beside a role to add it, and again to take it off.'));
      for (const item of roles) {
        container.addSectionComponents(new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${item.emoji || ''} <@&${item.role}>**\n${item.description || ''}`))
          .setButtonAccessory(new ButtonBuilder().setCustomId(`rolepanel:toggle:${message.guild.id}:${item.role}`).setLabel('Get / Remove').setStyle(ButtonStyle.Secondary)));
      }
      const payload = { components: [container], flags: MessageFlags.IsComponentsV2 };
      const key = `guild:${message.guild.id}:rolePanelMessage`;
      const saved = await client.db.get(key, null);
      let panelMessage = null;
      if (saved?.channelId && saved?.messageId) {
        const channel = await message.guild.channels.fetch(saved.channelId).catch(() => null);
        panelMessage = await channel?.messages.fetch(saved.messageId).catch(() => null);
      }
      if (panelMessage) {
        await panelMessage.edit(payload);
        await message.reply(`✅ Role panel updated: ${panelMessage.url}`);
      } else {
        panelMessage = await message.channel.send(payload);
        await client.db.set(key, { channelId: panelMessage.channelId, messageId: panelMessage.id });
        await message.reply(`✅ Role panel posted: ${panelMessage.url}`);
      }
      return;
    }

    // B-Shop panel remains a plain-text command; management uses slash subcommands.
    if (/^bshop\s+panel$/i.test(trimmedContent)) {
      if (message.author.id !== message.guild.ownerId) {
        await message.reply('❌ Only the **server owner** can use this command.');
        return;
      }
      const items = await getBShopItems(client, message.guild.id);
      await message.channel.send({
        components: [buildBShopPage(items, message.guild.id, 0)],
        flags: MessageFlags.IsComponentsV2,
      });
      return;
    }

    // Separate public panel for purchasable color roles.
    if (/^bshop\s+color$/i.test(trimmedContent)) {
      const items = await getBShopColorItems(client, message.guild.id);
      await message.channel.send({
        components: [buildBShopColorPage(items, message.guild, 0)],
        flags: MessageFlags.IsComponentsV2,
      });
      return;
    }

    // Public panel for Barracks Booster members' exclusive color roles.
    if (/^bshop\s+booster-color$/i.test(trimmedContent)) {
      const items = await getBShopBoosterColorItems(client, message.guild.id);
      await message.channel.send({
        components: [buildBShopBoosterColorPage(items, message.guild, 0)],
        flags: MessageFlags.IsComponentsV2,
      });
      return;
    }

    // Manage public invite reward announcements with prefix commands.
    const inviteRewardsMatch = trimmedContent.match(/^b!invite\s+rewards\s+(view|disable)$/i);
    if (inviteRewardsMatch) {
      if (!message.member?.permissions?.has('ManageGuild')) {
        await message.reply('❌ You need **Manage Server** permission to use this command.');
        return;
      }

      const inviteRewardChannelKey = `guild:${message.guild.id}:invite_reward_channel`;
      const action = inviteRewardsMatch[1].toLowerCase();

      if (action === 'view') {
        const channelId = await client.db.get(inviteRewardChannelKey, null);
        if (!channelId) {
          await message.reply('No public invite reward channel is configured. Inviter DMs will still be sent when possible.');
          return;
        }

        const channel = await message.guild.channels.fetch(channelId).catch(() => null);
        if (!channel) {
          await message.reply('The saved channel no longer exists. Use **/invite-rewards set-channel** to choose another one.');
          return;
        }

        await message.reply(`📍 Invite reward announcements: <#${channel.id}>`);
        return;
      }

      await client.db.delete(inviteRewardChannelKey);
      await message.reply('✅ Public invite reward announcements are disabled. Inviter DMs will still be sent when possible.');
      return;
    }

    // Owner-only test utility for the Barracks invite bCash reward.
    if (/^b!testinvite\s+reward$/i.test(trimmedContent)) {
      const BARRACKS_GUILD_ID = '1137695060096471160';
      if (message.guild.id !== BARRACKS_GUILD_ID) {
        await message.reply('❌ This test command is only available in the Barracks server.');
        return;
      }
      if (!isBotOwner(message.author.id)) {
        await message.reply('❌ Only the configured bot owner can use this test command.');
        return;
      }

      const { addMoney } = await import('../utils/economy.js');
      const reward = await addMoney(client, message.guild.id, message.author.id, 100000, 'wallet');
      const amountText = '100,000';
      const balanceText = Number(reward.newBalance || 0).toLocaleString('en-US');
      const testEmbed = new EmbedBuilder()
        .setColor(0xD4AF37)
        .setTitle('🎉 Invite Reward Received!')
        .setDescription('Thanks for helping grow the **Barracks** community! Your invite brought a new recruit to Barracks.')
        .addFields(
          { name: '💰 Reward Earned', value: `**+${amountText} bCash**`, inline: true },
          { name: '🪖 New Recruit', value: '**@John Smith**', inline: true },
          { name: '💳 New Wallet Balance', value: `**${balanceText} bCash**`, inline: false },
        )
        .setFooter({ text: 'Barracks • Invite Rewards' })
        .setTimestamp();

      try {
        await message.author.send({ embeds: [testEmbed] });
        await message.reply('✅ Test reward credited! I sent the confirmation to your DMs.');
      } catch (error) {
        logger.info(`Could not DM invite reward test confirmation to ${message.author.id}: ${error.message}`);
        await message.reply('✅ Test reward was credited, but I could not DM you. Please enable server-member DMs and check your wallet before running the command again.');
      }
      return;
    }

    // Authorized staff entry point for the paid nickname panel.
    // Keep this ahead of category/command-access gates.
    if (/^b!nickname\s+panel$/i.test(trimmedContent)) {
      const hasNicknamePanelAccess =
        message.author.id === message.guild.ownerId ||
        message.member?.permissions?.has('ManageGuild') ||
        message.member?.roles?.cache?.has('1557784202844446750');
      if (!hasNicknamePanelAccess) {
        await message.reply('❌ You need **Manage Server** permission or the authorized Nickname Panel role to post this panel.');
        return;
      }
      const nicknameCommand = client.commands.get('nickname');
      if (!nicknameCommand?.execute) {
        logger.error('Nickname panel command is not loaded.');
        await message.channel.send('❌ The nickname panel is temporarily unavailable. Please contact an administrator.');
        return;
      }
      await nicknameCommand.execute({
        channel: message.channel,
        user: message.author,
        client,
        guild: message.guild,
        guildId: message.guild.id,
      });
      return;
    }
    if (/^bclan\s+joinpanel$/i.test(trimmedContent)) {
      if (!message.member?.permissions?.has('ManageGuild')) {
        await message.reply('❌ Only members with **Manage Server** permission can post the Clan Joining Panel.');
        return;
      }
      const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');
      const approved = await client.db.get(`guild:${message.guild.id}:clans`, []);
      const available = (Array.isArray(approved) ? approved : []).filter(clan => clan.status === 'approved' && clan.roleId);
      const panelEmbed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🛡️ JOIN AN EXISTING CLAN')
        .setDescription(
          'Looking to join a squad? Browse the approved clans and submit your membership application.\n\n' +
          '**How it works**\n' +
          '• Choose an approved clan from the list.\n' +
          '• Your application is sent privately to the Clan Leader and Vice Clan Leader.\n' +
          '• Either leader can accept or decline your application.\n' +
          '• If accepted, you receive the clan role and clan tag in your nickname.\n\n' +
          (available.length ? `**Currently available:** ${available.length} approved clan(s)` : 'There are no approved clans available right now.')
        )
        .setFooter({ text: 'Barracks • Clan Registry' });
      const panelRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('clan:join:open').setLabel('Browse Clans').setEmoji('🏰').setStyle(ButtonStyle.Primary)
      );
      await message.channel.send({ embeds: [panelEmbed], components: [panelRow] });
      return;
    }

    if (/^bclan\s+panel$/i.test(trimmedContent)) {
      if (!message.member?.permissions?.has('ManageGuild')) {
        await message.reply('❌ Only members with **Manage Server** permission can post the Clan Registration Panel.');
        return;
      }
      const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');
      const panelEmbed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🏰 BARRACKS CLAN REGISTRATION')
        .setDescription(
          'Ready to lead your own squad? Create a clan and bring your soldiers together!\n\n' +
          '**Information required**\n' +
          '• Clan Name\n' +
          '• Clan Tag + Role Hex (1–6 characters; letters, numbers, symbols, or emoji)\n' +
          '• Clan Description\n' +
          '• Vice Clan Leader\n' +
          '• Clan Logo\n\n' +
          'Your account will automatically be registered as the **Clan Leader**.\n' +
          'All clan registrations are subject to staff approval.'
        )
        .setFooter({ text: 'Barracks • Clan Registry' });
      const panelRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('clan:create')
          .setLabel('Create a Clan')
          .setEmoji('🏰')
          .setStyle(ButtonStyle.Primary)
      );
      await message.channel.send({ embeds: [panelEmbed], components: [panelRow] });
      return;
    }

    const bareCountMatch = trimmedContent.match(/^bcount(?:\s+([\s\S]+))?$/i);
    const bareBgiveMatch = trimmedContent.match(/^bgive(?:\s+([\s\S]+))?$/i);
    const bareMinesMatch = trimmedContent.match(/^bmines?(?:\s+([\s\S]+))?$/i);
    const bareCashMatch = trimmedContent.match(/^bcash(?:\s+([\s\S]+))?$/i);
    const bareBlackjackMatch = trimmedContent.match(/^bbj(?:\s+([\s\S]+))?$/i);
    const bareSlotsMatch = trimmedContent.match(/^bslot(?:\s+([\s\S]+))?$/i);
    const bareMemoryMatch = trimmedContent.match(/^bmem(?:\s+([\s\S]+))?$/i);
    const bareHigherLowerMatch = trimmedContent.match(/^bhl(?:\s+([\s\S]+))?$/i);
    const bareDailyMatch = trimmedContent.match(/^bdaily$/i);
    const bareWorkMatch = trimmedContent.match(/^bwork$/i);
    const bareShopMatch = trimmedContent.match(/^bshop$/i);
    const bareTalpakMatch = trimmedContent.match(/^btalpak(?:\s+([\s\S]+))?$/i);
    const bareDepositMatch = trimmedContent.match(/^bdeposit(?:\s+([\s\S]+))?$/i);
    const bareBdepMatch = trimmedContent.match(/^bdep(?:\s+([\s\S]+))?$/i);
    const bareWithdrawMatch = trimmedContent.match(/^bwithdraw(?:\s+([\s\S]+))?$/i);
    const bareBwithMatch = trimmedContent.match(/^bwith(?:\s+([\s\S]+))?$/i);
    const bareTicTacToeMatch = trimmedContent.match(/^(?:bttt|btictactoe)(?:\s+([\s\S]+))?$/i);
    const bareCoinFlipMatch = trimmedContent.match(/^bcf(?:\s+([\s\S]+))?$/i);
    const bareRouletteMatch = trimmedContent.match(/^broulette(?:\s+([\s\S]+))?$/i);
    const bareRpsMatch = trimmedContent.match(/^(?:brps|b!rps)(?:\s+([\s\S]+))?$/i);
    const parsed = bareMemoryMatch
      ? { commandName: 'bmem', args: bareMemoryMatch[1] ? bareMemoryMatch[1].trim().split(/\s+/) : [] }
      : bareCountMatch
      ? { commandName: 'bcount', args: bareCountMatch[1] ? bareCountMatch[1].trim().split(/\s+/) : [] }
      : bareBgiveMatch
      ? (() => {
          const parts = bareBgiveMatch[1] ? bareBgiveMatch[1].trim().split(/\s+/) : [];
          // Accept both: bgive @receiver amount, and bgive amount @receiver.
          const isMention = (value) => /^<@!?\d+>$/.test(value || '');
          const args = parts.length >= 2 && /^\d+$/.test(parts[0]) && isMention(parts[1])
            ? [parts[1], parts[0], ...parts.slice(2)]
            : parts;
          return { commandName: 'bgive', args };
        })()
      : bareMinesMatch
      ? { commandName: 'bmine', args: bareMinesMatch[1] ? bareMinesMatch[1].trim().split(/\s+/) : [] }
      : bareCashMatch
        ? { commandName: 'balance', args: bareCashMatch[1] ? bareCashMatch[1].trim().split(/\s+/) : [] }
        : bareBlackjackMatch
          ? { commandName: 'bblackjack', args: bareBlackjackMatch[1] ? bareBlackjackMatch[1].trim().split(/\s+/) : [] }
          : bareSlotsMatch
            ? { commandName: 'bslot', args: bareSlotsMatch[1] ? bareSlotsMatch[1].trim().split(/\s+/) : [] }
            : bareHigherLowerMatch
            ? { commandName: 'bhl', args: bareHigherLowerMatch[1] ? bareHigherLowerMatch[1].trim().split(/\s+/) : [] }
          : bareDailyMatch
            ? { commandName: 'daily', args: [] }
            : bareWorkMatch
              ? { commandName: 'work', args: [] }
              : bareShopMatch
                ? { commandName: 'shop', args: [] }
                : bareTalpakMatch
                  ? { commandName: 'btalpak', args: bareTalpakMatch[1] ? bareTalpakMatch[1].trim().split(/\s+/) : [] }
                  : (bareDepositMatch || bareBdepMatch)
            ? { commandName: 'deposit', args: (bareDepositMatch || bareBdepMatch)[1] ? [(bareDepositMatch || bareBdepMatch)[1].trim()] : [] }
            : (bareWithdrawMatch || bareBwithMatch)
              ? { commandName: 'withdraw', args: (bareWithdrawMatch || bareBwithMatch)[1] ? [(bareWithdrawMatch || bareBwithMatch)[1].trim()] : [] }
              : bareTicTacToeMatch
                ? { commandName: 'tictactoe', args: bareTicTacToeMatch[1] ? bareTicTacToeMatch[1].trim().split(/\s+/) : [] }
              : bareRouletteMatch
              ? { commandName: 'broulette', args: bareRouletteMatch[1] ? bareRouletteMatch[1].trim().split(/\s+/) : [] }
              : bareRpsMatch
              ? { commandName: 'rps', args: bareRpsMatch[1] ? bareRpsMatch[1].trim().split(/\s+/) : [] }
              : bareCoinFlipMatch
              ? (() => {
                  const parts = bareCoinFlipMatch[1] ? bareCoinFlipMatch[1].trim().split(/\s+/) : [];
                  const first = parts[0]?.toLowerCase();
                  const last = parts[1]?.toLowerCase();

                  // Accept both bcf t 1000 and bcf 1000 t (same for heads).
                  if (first === 't' || first === 'tails') {
                    return { commandName: 'coinflip', args: [parts[1] || '', 'tails'] };
                  }
                  if (first === 'h' || first === 'heads') {
                    return { commandName: 'coinflip', args: [parts[1] || '', 'heads'] };
                  }
                  if (last === 't' || last === 'tails') {
                    return { commandName: 'coinflip', args: [parts[0] || '', 'tails'] };
                  }
                  if (last === 'h' || last === 'heads') {
                    return { commandName: 'coinflip', args: [parts[0] || '', 'heads'] };
                  }
                  return { commandName: 'coinflip', args: [parts[0] || '', 'heads'] };
                })()
              : parsePrefixCommand(message.content, prefix);

    if (!parsed) {
      return; 
    }

    let { commandName, args } = parsed;
    const musicPrefixShortcut = commandName.toLowerCase();
    const MUSIC_PREFIX_SHORTCUTS = new Set(['leave', 'pause', 'resume', 'skip', 'stop', 'volume']);
    if (MUSIC_PREFIX_SHORTCUTS.has(musicPrefixShortcut)) {
      commandName = 'music';
      args = [musicPrefixShortcut, ...args];
    }

    logger.info(`Prefix command detected: ${commandName}, args: ${args.join(', ')}`);

    const resolvedCommandName = resolveCommandAlias(commandName);
    logger.info(`Resolved command name: ${resolvedCommandName}`);
    const command = client.commands.get(resolvedCommandName);

    if (!command) {
      logger.warn(`Command not found: ${resolvedCommandName}`);
      return; 
    }

    if (isMaintenanceMode() && !isBotOwner(message.author.id)) {
      await message.channel.send({
        embeds: [createEmbed({
          title: 'Maintenance Mode',
          description: getBotMessage('maintenanceMode'),
          color: 'warning',
        })],
      }).catch(() => {});
      return;
    }

    if (!isCommandCategoryEnabled(command.category)) {
      await message.channel.send({
        embeds: [createEmbed({
          title: 'Feature Disabled',
          description: getBotMessage('commandDisabled'),
          color: 'error',
        })],
      }).catch(() => {});
      return;
    }

    // RPS prefix aliases accept the opponent and optional wager in either order:
    // brps @member bet:50000 | brps bet:50000 @member | b!rps ...
    if (resolvedCommandName === 'rps' && /^(?:brps|b!rps|b\\s+rps)\\b/i.test(trimmedContent)) {
      const tail = trimmedContent.replace(/^(?:brps|b!rps|b\\s+rps)\\b/i, '').trim();
      const mention = tail.match(/<@!?(\\d+)>/);
      const betMatch = tail.match(/(?:^|\\s)bet\\s*:\\s*(\\d+)(?=\\s|$)/i);
      if (!mention) {
        await message.reply('Usage: `brps @member bet:50000` or `brps bet:50000 @member`');
        return;
      }
      const opponent = await client.users.fetch(mention[1]).catch(() => null);
      if (!opponent) {
        await message.reply('❌ I could not find that member. Please mention a server member.');
        return;
      }
      const bet = betMatch ? Number(betMatch[1]) : null;
      if (betMatch && (!Number.isSafeInteger(bet) || bet < 1 || bet > 1000000000)) {
        await message.reply('❌ Bet must be between 1 and 1,000,000,000 bCash.');
        return;
      }
      const rpsCommand = client.commands.get('rps');
      const fakeInteraction = {
        id: message.id,
        client,
        guild: message.guild,
        guildId: message.guild.id,
        user: message.author,
        member: message.member,
        inGuild: () => true,
        options: {
          getUser: () => opponent,
          getInteger: () => bet,
        },
        reply: async payload => message.channel.send({
          content: payload.content,
          embeds: payload.embeds,
          components: payload.components,
          allowedMentions: { parse: ['users'] },
        }),
      };
      await rpsCommand.execute(fakeInteraction);
      return;
    }

    const restriction = getPrefixRestriction(command, args, resolveSubcommandAlias);
    if (!supportsPrefixExecution(command) || restriction.blocked) {
      if (restriction.blocked && restriction.reason) {
        const embed = createEmbed({
          title: 'Slash Command Only',
          description: `${restriction.reason}\nUse \`/${resolvedCommandName}\` instead.`,
          color: 'info',
        });
        await message.channel.send({ embeds: [embed] }).catch(() => {});
      }
      return;
    }

    if (!(await isCommandEnabled(client, message.guild.id, resolvePrefixAccessKey(command.data, args), command.category))) {
      const embed = createEmbed({
        title: 'Command Disabled',
        description: 'This command has been disabled for this server.',
        color: 'error',
      });
      await message.channel.send({ embeds: [embed] }).catch(() => {});
      return;
    }

    const mockInteractionForProtection = {
      guildId: message.guild.id,
      user: message.author,
    };
    const abuseProtection = await enforceAbuseProtection(
      mockInteractionForProtection,
      command,
      resolvedCommandName,
    );
    if (!abuseProtection.allowed) {
      const formattedCooldown = formatCooldownDuration(abuseProtection.remainingMs);
      const embed = createEmbed({
        title: 'Command Cooldown',
        description: `This command is on cooldown. Please wait ${formattedCooldown} before trying again.`,
        color: 'error',
      });
      await message.channel.send({ embeds: [embed] }).catch(() => {});
      return;
    }

    logger.info(`Executing prefix command: ${prefix}${commandName} (resolved to ${resolvedCommandName}) by ${message.author.tag}`);
    
    await executePrefixCommand(command, message, args, client, prefix, guildConfig);
  } catch (error) {
    logger.error('Error handling prefix command:', error);
  }
}

async function handleCountingGame(message, client) {
  try {
    // Management commands must remain usable even inside the configured counting channel.
    if (/^bcount(?:\s|$)/i.test(message.content.trim())) return false;
    const config = await getCountingGameConfig(client, message.guild.id);
    if (!config.enabled || !config.channelId || message.channel.id !== config.channelId) {
      return false;
    }

    const content = message.content.trim();
    const validCount = isValidCountingMessage(content, config);
    const invalidAttempt = !validCount || message.author.id === config.lastUserId;

    if (invalidAttempt) {
      // Keep the incorrect message visible so members can see the ❌ reaction.
      await message.react('❌').catch(error => {
        logger.warn('Could not add incorrect-count reaction:', error);
      });
      await saveCountingGameConfig(client, message.guild.id, {
        ...config,
        nextNumber: 1,
        lastUserId: null,
        currentStreak: 0,
      });

      const failureMessage = await message.channel.send(`❌ Count broken by <@${message.author.id}>. The sequence has been reset to **1**.`);
      setTimeout(() => {
        failureMessage.delete().catch(() => {});
      }, 10000);

      return true;
    }

    await recordCorrectCount(client, message.guild.id, message.author.id);
    await message.react('✅').catch(error => {
      logger.warn('Could not add correct-count reaction:', error);
    });
    return true;
  } catch (error) {
    logger.error('Error handling counting game:', error);
    return false;
  }
}

async function handleLeveling(message, client) {
  try {
    const rateLimitKey = `xp-event:${message.guild.id}:${message.author.id}`;
    const canProcess = await checkRateLimit(rateLimitKey, MESSAGE_XP_RATE_LIMIT_ATTEMPTS, MESSAGE_XP_RATE_LIMIT_WINDOW_MS);
    if (!canProcess) {
      return;
    }

    const levelingConfig = await getLevelingConfig(client, message.guild.id);
    
    if (!levelingConfig?.enabled) {
      return;
    }

    if (levelingConfig.ignoredChannels?.includes(message.channel.id)) {
      return;
    }

    if (levelingConfig.ignoredRoles?.length > 0) {
      const member = await message.guild.members.fetch(message.author.id).catch(() => {
        return null;
      });
      if (member && member.roles.cache.some(role => levelingConfig.ignoredRoles.includes(role.id))) {
        return;
      }
    }

    if (levelingConfig.blacklistedUsers?.includes(message.author.id)) {
      return;
    }

    if (!message.content || message.content.trim().length === 0) {
      return;
    }

    const userData = await getUserLevelData(client, message.guild.id, message.author.id);

    const cooldownTime = levelingConfig.xpCooldown ?? 60;
    const now = Date.now();
    const timeSinceLastMessage = now - (userData.lastMessage || 0);

    if (timeSinceLastMessage < cooldownTime * 1000) {
      return;
    }

    const minXP = levelingConfig.xpRange?.min || levelingConfig.xpPerMessage?.min || 15;
    const maxXP = levelingConfig.xpRange?.max || levelingConfig.xpPerMessage?.max || 25;

    const safeMinXP = Math.max(1, minXP);
    const safeMaxXP = Math.max(safeMinXP, maxXP);

    const xpToGive = Math.floor(Math.random() * (safeMaxXP - safeMinXP + 1)) + safeMinXP;

    let finalXP = xpToGive;
    if (levelingConfig.xpMultiplier && levelingConfig.xpMultiplier > 1) {
      finalXP = Math.floor(finalXP * levelingConfig.xpMultiplier);
    }

    const result = await addXp(client, message.guild, message.member, finalXP);

    if (result?.leveledUp) {
      logger.info(
        `${message.author.tag} leveled up to level ${result.level} in ${message.guild.name}`
      );
    }
  } catch (error) {
    logger.error('Error handling leveling for message:', error);
  }
}
