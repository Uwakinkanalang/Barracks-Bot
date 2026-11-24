import { ChannelType, Events, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import {
  getBotMessage,
  isBotOwner,
  isCommandCategoryEnabled,
  isMaintenanceMode,
} from '../config/bot.js';
import botConfig from '../config/bot.js';
import { handleApplicationModal } from '../commands/Community/apply.js';
import { handleInteractionError, createError, ErrorTypes, ErrorCodes } from '../utils/errorHandler.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { createInteractionTraceContext, runWithTraceContext } from '../utils/logger.js';
import { validateChatInputPayloadOrThrow } from '../utils/commandInputValidation.js';
import { enforceAbuseProtection, formatCooldownDuration } from '../utils/abuseProtection.js';
import { isCommandEnabled } from '../services/commandAccessService.js';
import { resolveSlashAccessKey } from '../utils/messageAdapter.js';
import { isCollectorManagedComponent } from '../utils/collectorComponents.js';
import { ResponseCoordinator } from '../utils/responseCoordinator.js';
import { enforceDefaultCommandPermissions } from '../utils/permissionGuard.js';
import { getNicknamePrefix, handleNicknameChangeButton, handleNicknameChangeModal } from '../commands/Economy/nickname.js';
import { getAFKKey } from '../utils/database.js';
import { getItems as getBShopItems, getColorItems as getBShopColorItems, getBoosterColorItems as getBShopBoosterColorItems, buildColorShopPage, buildBoosterColorShopPage } from '../commands/Economy/roleshop.js';
import { getEconomyData, getMaxBankCapacity, setEconomyData, removeMoney, addMoney } from '../utils/economy.js';
import { getClanShopItems, buildClanShopPage } from '../commands/Economy/clanshop.js';
import { getCalendarEvents, buildCalendarPayload, parseCalendarMonth, formatCalendarEvent } from '../services/calendarService.js';

const COMMAND_ERROR_SUBTYPES = {
  warn: 'warn_failed',
  kick: 'kick_failed',
  ban: 'ban_failed',
  unban: 'unban_failed',
  timeout: 'timeout_failed',
  untimeout: 'untimeout_failed',
  warnings: 'warnings_view_failed',
  ticket: 'ticket_failed',
  serverstats: 'serverstats_failed',
  gcreate: 'giveaway_failed',
  gend: 'giveaway_failed',
  gdelete: 'giveaway_failed',
  greroll: 'giveaway_failed',
};

async function applyHighestPriorityAutoNick(member) {
  const { client, guild } = member;
  const stored = await client.db.get(`guild:${guild.id}:autonick_roles`, []);
  const configs = (Array.isArray(stored) ? stored : [])
    .filter((entry) => entry && typeof entry.roleId === 'string')
    .map((entry) => ({ ...entry, priority: Number(entry.priority) || 0 }))
    .sort((a, b) => b.priority - a.priority);
  const active = configs.find((entry) => member.roles.cache.has(entry.roleId)) || null;
  const stateKey = `guild:${guild.id}:autonick_member:${member.id}`;
  const state = await client.db.get(stateKey, null);
  let base = typeof state?.originalNickname === 'string'
    ? state.originalNickname
    : (member.nickname ?? member.user.globalName ?? member.user.username);
  base = String(base).replace(/^\[AFK\]\s*/u, '').trimStart();
  // Strip existing AutoNick tags and prefixes before applying the winning format.
  // Handle plain, bracketed, and pipe-separated clan tag styles.
  const markers = [...new Set(configs.flatMap((entry) => {
    const tag = String(entry.tag || '').trim();
    const prefix = String(entry.prefix || '').trim();
    return [tag, prefix, ...(tag ? [`[${tag}]`, `[${tag}]|`, `${tag}|`] : [])].filter(Boolean);
  }))].sort((a, b) => b.length - a.length);
  let matched;
  do {
    matched = markers.find((marker) => base.toLowerCase().startsWith(marker.toLowerCase()));
    if (matched) base = base.slice(matched.length).replace(/^[-_|:：\s]+/u, '');
  } while (matched);
  if (!base.trim()) base = member.user.globalName || member.user.username;

  let desired;
  if (active) {
    const template = typeof active.format === 'string' && active.format.includes('{username}')
      ? active.format
      : `${String(active.prefix || '').trim()} {username}`;
    const taggedTemplate = active.tag && !/\bTAG\b/i.test(template) ? `TAG ${template}` : template;
    desired = taggedTemplate.replace(/\bTAG\b/gi, String(active.tag || ''))
      .replace(/\{username\}/gi, base).replace(/\s+/g, ' ').trim().slice(0, 32);
    await client.db.set(stateKey, { originalNickname: base, savedAt: state?.savedAt || Date.now() });
  } else if (state) {
    desired = state.hadNickname === false ? null : (base || null);
    await client.db.delete(stateKey).catch(() => {});
  } else {
    const normalPrefix = await getNicknamePrefix(member, client, guild.id);
    desired = `${normalPrefix}${base}`.slice(0, 32) || null;
  }

  const afkKey = getAFKKey(guild.id, member.id);
  const afk = await client.db.get(afkKey, null);
  if (afk) {
    afk.originalNickname = desired;
    afk.afkNickname = desired ? `[AFK] ${desired}`.slice(0, 32) : null;
    await client.db.set(afkKey, afk);
    desired = afk.afkNickname;
  }
  if (member.nickname !== desired && member.manageable) {
    await member.setNickname(desired, 'Recalculate highest-priority AutoNick after clan membership change');
  }
}

function withTraceContext(context = {}, traceContext = {}) {
  return {
    traceId: traceContext.traceId,
    guildId: context.guildId || traceContext.guildId,
    userId: context.userId || traceContext.userId,
    command: context.commandName || traceContext.command,
    ...context
  };
}

export default {
  name: Events.InteractionCreate,
  async execute(interaction, client) {
    const interactionTraceContext = createInteractionTraceContext(interaction);
    interaction.traceContext = interactionTraceContext;
    interaction.traceId = interactionTraceContext.traceId;

    return runWithTraceContext(interactionTraceContext, async () => {
      try {
        InteractionHelper.patchInteractionResponses(interaction);
        ResponseCoordinator.attach(interaction);

        if (interaction.isChatInputCommand()) {
          try {
            logger.info(`Command executed: /${interaction.commandName} by ${interaction.user.tag}`, {
              event: 'interaction.command.received',
              traceId: interactionTraceContext.traceId,
              guildId: interaction.guildId,
              userId: interaction.user?.id,
              command: interaction.commandName
            });

            validateChatInputPayloadOrThrow(interaction, withTraceContext({
              type: 'command_input_validation',
              commandName: interaction.commandName
            }, interactionTraceContext));

            const command = client.commands.get(interaction.commandName);

            if (!command) {
              throw createError(
                `No command matching ${interaction.commandName} was found.`,
                ErrorTypes.CONFIGURATION,
                'Sorry, that command does not exist.',
                withTraceContext({ commandName: interaction.commandName }, interactionTraceContext)
              );
            }

            if (isMaintenanceMode() && !isBotOwner(interaction.user.id)) {
              throw createError(
                'Bot is in maintenance mode',
                ErrorTypes.CONFIGURATION,
                getBotMessage('maintenanceMode'),
                withTraceContext({ commandName: interaction.commandName }, interactionTraceContext)
              );
            }

            if (!isCommandCategoryEnabled(command.category)) {
              throw createError(
                `Feature disabled for category ${command.category}`,
                ErrorTypes.CONFIGURATION,
                getBotMessage('commandDisabled'),
                withTraceContext({ commandName: interaction.commandName, category: command.category }, interactionTraceContext)
              );
            }

            const defaultCooldownSec = Number(botConfig.commands?.defaultCooldown) || 0;
            if (defaultCooldownSec > 0 && !isBotOwner(interaction.user.id)) {
              const cooldownKey = `${interaction.user.id}:${interaction.commandName}`;
              const expiresAt = client.cooldowns.get(cooldownKey);

              if (expiresAt && Date.now() < expiresAt) {
                const remainingSec = Math.ceil((expiresAt - Date.now()) / 1000);
                throw createError(
                  `Default command cooldown active for ${interaction.commandName}`,
                  ErrorTypes.RATE_LIMIT,
                  getBotMessage('cooldownActive', { time: `${remainingSec}s` }),
                  withTraceContext({ commandName: interaction.commandName, remainingSec }, interactionTraceContext)
                );
              }

              client.cooldowns.set(cooldownKey, Date.now() + defaultCooldownSec * 1000);
            }

            const abuseProtection = await enforceAbuseProtection(interaction, command, interaction.commandName);
            if (!abuseProtection.allowed) {
              const formattedCooldown = formatCooldownDuration(abuseProtection.remainingMs);
              throw createError(
                `Risky command cooldown active for ${interaction.commandName}`,
                ErrorTypes.RATE_LIMIT,
                `This command is on cooldown. Please wait ${formattedCooldown} before trying again.`,
                withTraceContext({
                  commandName: interaction.commandName,
                  subtype: 'command_cooldown',
                  expected: true,
                  cooldownMs: abuseProtection.remainingMs,
                  cooldownWindowMs: abuseProtection.policy?.windowMs,
                  cooldownMaxAttempts: abuseProtection.policy?.maxAttempts
                }, interactionTraceContext)
              );
            }

            let guildConfig = null;
            if (interaction.guild) {
              guildConfig = await getGuildConfig(client, interaction.guild.id, interactionTraceContext);
              const accessKey = resolveSlashAccessKey(interaction);
              if (!(await isCommandEnabled(client, interaction.guild.id, accessKey, command.category, 'slash'))) {
                throw createError(
                  `Command ${accessKey} is disabled in this guild`,
                  ErrorTypes.CONFIGURATION,
                  'This command has been disabled for this server.',
                  withTraceContext({ commandName: accessKey, guildId: interaction.guild.id }, interactionTraceContext)
                );
              }
            }

            const permissionAllowed = await enforceDefaultCommandPermissions(interaction, command, {
              source: 'interactionCreate',
              guildConfig,
            });
            if (!permissionAllowed) {
              return;
            }

            await command.execute(interaction, guildConfig, client);
          } catch (error) {
            await handleInteractionError(interaction, error, withTraceContext({
              type: 'command',
              commandName: interaction.commandName,
              subtype: COMMAND_ERROR_SUBTYPES[interaction.commandName] || error?.context?.subtype,
            }, interactionTraceContext));
          }
        } else if (interaction.isAutocomplete()) {
          const autocompleteCommand = client.commands.get(interaction.commandName);
          if (autocompleteCommand?.autocomplete) {
            try {
              await autocompleteCommand.autocomplete(interaction, client);
            } catch (error) {
              logger.error('Error handling command autocomplete:', {
                error: error.message,
                guildId: interaction.guildId,
                commandName: interaction.commandName,
              });
              await interaction.respond([]).catch(() => {});
            }
            return;
          }

          const focusedOption = interaction.options.getFocused(true);
          
          if (interaction.commandName === 'apply' && focusedOption.name === 'application') {
            try {
              const { getApplicationRoles } = await import('../utils/database.js');
              const roles = await getApplicationRoles(client, interaction.guildId);
              const roleName = interaction.options.getString('application', false);

              const filtered = roles.filter(role =>
                role.enabled !== false && 
                role.name.toLowerCase().startsWith(roleName?.toLowerCase() || '')
              );
              
              await interaction.respond(
                filtered.slice(0, 25).map(role => ({
                  name: `${role.name}${role.enabled === false ? ' (disabled)' : ''}`,
                  value: role.name
                }))
              );
            } catch (error) {
              logger.error('Error handling autocomplete:', {
                error: error.message,
                guildId: interaction.guildId,
                commandName: interaction.commandName
              });
              await interaction.respond([]);
            }
          } else if (interaction.commandName === 'app-admin' && focusedOption.name === 'application') {
            try {
              const { getApplicationRoles } = await import('../utils/database.js');
              const roles = await getApplicationRoles(client, interaction.guildId);
              const appName = interaction.options.getString('application', false);

              const filtered = roles.filter(role =>
                role.name.toLowerCase().startsWith(appName?.toLowerCase() || '')
              );
              
              await interaction.respond(
                filtered.slice(0, 25).map(role => ({
                  name: `${role.name}${role.enabled === false ? ' (disabled)' : ''}`,
                  value: role.name
                }))
              );
            } catch (error) {
              logger.error('Error handling app-admin autocomplete:', {
                error: error.message,
                guildId: interaction.guildId,
                commandName: interaction.commandName
              });
              await interaction.respond([]);
            }
          } else if (interaction.commandName === 'reactroles' && focusedOption.name === 'panel') {
            try {
              const { getAllReactionRoleMessages, deleteReactionRoleMessage } = await import('../services/reactionRoleService.js');
              const guildId = interaction.guildId;
              const guild = interaction.guild;
              
              let panels = await getAllReactionRoleMessages(client, guildId);
              
              if (!panels || panels.length === 0) {
                await interaction.respond([]);
                return;
              }

              const validPanels = [];
              for (const panel of panels) {
                if (!panel.messageId || !panel.channelId) {
                  continue;
                }
                
                const channel = guild.channels.cache.get(panel.channelId);
                if (!channel) {
                  await deleteReactionRoleMessage(client, guildId, panel.messageId).catch(() => {});
                  continue;
                }
                
                const msg = await channel.messages.fetch(panel.messageId).catch(() => null);
                if (!msg) {
                  await deleteReactionRoleMessage(client, guildId, panel.messageId).catch(() => {});
                  continue;
                }
                validPanels.push(panel);
              }
              
              if (validPanels.length === 0) {
                await interaction.respond([]);
                return;
              }
              
              const choices = await Promise.all(
                validPanels.slice(0, 25).map(async panel => {
                  try {
                    const channel = guild.channels.cache.get(panel.channelId);
                    if (!channel) return null;
                    
                    const msg = await channel.messages.fetch(panel.messageId).catch(() => null);
                    if (!msg) return null;
                    
                    const title = msg?.embeds?.[0]?.title ?? 'Untitled Panel';
                    const channelName = channel?.name ?? 'unknown';
                    
                    return {
                      name: `${title} (${channelName})`.substring(0, 100),
                      value: panel.messageId
                    };
                  } catch (e) {
                    return null;
                  }
                })
              );
              
              const validChoices = choices.filter(c => c !== null);
              await interaction.respond(validChoices);
            } catch (error) {
              logger.error('Error handling reactroles autocomplete:', {
                error: error.message,
                guildId: interaction.guildId,
                commandName: interaction.commandName
              });
              await interaction.respond([]);
            }
          }
        } else if (interaction.isButton()) {
          if (interaction.customId.startsWith('tournament:accept:')) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const [, , guildId, tournamentId, teamId] = interaction.customId.split(':');
            const key = 'guild:' + guildId + ':tournaments';
            const stored = await client.db.get(key, []);
            const tournaments = Array.isArray(stored) ? stored : [];
            const tournament = tournaments.find(item => item.id === tournamentId);
            const team = tournament?.teams?.find(entry => entry.id === teamId);
            const pending = tournament?.pendingTeamInvites || [];
            const inviteIndex = pending.findIndex(entry => entry.userId === interaction.user.id && entry.teamId === teamId);
            if (!tournament || !team || inviteIndex < 0) { await interaction.editReply({ content: 'This team invitation is no longer valid.' }); return; }
            if (tournament.status !== 'registration' || (tournament.deadline && Date.now() > Date.parse(tournament.deadline))) { await interaction.editReply({ content: 'Team registration is closed.' }); return; }
            const max = Number(tournament.teamMaxPlayers || 5);
            if ((tournament.registrations || []).some(entry => entry.userId === interaction.user.id)) { await interaction.editReply({ content: 'You are already registered in this tournament.' }); return; }
            if (1 + (team.members || []).length >= max || tournament.registrations.length >= Number(tournament.limit)) { await interaction.editReply({ content: 'This team or tournament is now full.' }); return; }
            team.members.push(interaction.user.id);
            tournament.registrations.push({ userId: interaction.user.id, username: interaction.user.globalName || interaction.user.username, registeredAt: new Date().toISOString(), teamId: team.id });
            pending.splice(inviteIndex, 1);
            tournament.pendingTeamInvites = pending;
            await client.db.set(key, tournaments);
            await interaction.editReply({ content: 'You joined **' + team.name + '** for **' + tournament.name + '**.' });
            return;
          }
          if (interaction.customId.startsWith('tournament:')) {
            const action = interaction.customId.split(':')[1];
            const tournamentId = interaction.customId.split(':').slice(2).join(':');
            if (action === 'teamcreate' || action === 'teaminvite') {
              const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = await import('discord.js');
              const modal = new ModalBuilder().setCustomId('tournament:modal:' + action + ':' + tournamentId).setTitle(action === 'teamcreate' ? 'Create Tournament Team' : 'Invite a Player');
              const field = new TextInputBuilder().setCustomId(action === 'teamcreate' ? 'team_name' : 'member_id').setLabel(action === 'teamcreate' ? 'Team name' : 'Player mention or Discord ID').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(action === 'teamcreate' ? 32 : 30);
              modal.addComponents(new ActionRowBuilder().addComponents(field));
              await interaction.showModal(modal);
              return;
            }
            // Acknowledge immediately: database and Discord API calls can exceed Discord's 3-second window.
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const key = `guild:${interaction.guildId}:tournaments`;
            const stored = await client.db.get(key, []);
            const tournaments = Array.isArray(stored) ? stored : [];
            const tournament = tournaments.find(item => item.id === tournamentId);
            if (!tournament) {
              await interaction.editReply({ content: 'This tournament could not be found.' });
              return;
            }
            const refreshTournamentAnnouncement = async () => {
              const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');
              const embed = new EmbedBuilder()
                .setColor(/^#[0-9a-f]{6}$/i.test(tournament.color || '') ? tournament.color : '#C3F36B')
                .setTitle('🏆 ' + tournament.name);
              if (tournament.author) embed.setAuthor({ name: tournament.author, ...(tournament.authorIcon ? { iconURL: tournament.authorIcon } : {}) });
              const details = [
                tournament.description || 'Join the competition and prove your skills!',
                '**Game:** ' + tournament.game,
                '**Date:** ' + new Date(tournament.date).toLocaleString(),
                '**Format:** ' + tournament.format,
                '**Players:** ' + (tournament.registrations?.length || 0) + ' / ' + tournament.limit,
                '**Registration:** ' + (tournament.status === 'registration' ? 'OPEN' : tournament.status.toUpperCase())
              ];
              if (tournament.deadline) details.push('**Registration Deadline:** ' + new Date(tournament.deadline).toLocaleString());
              if (tournament.prizePool) details.push('**Prize Pool:** ' + tournament.prizePool);
              if (tournament.entryFee) details.push('**Entry Fee:** ' + tournament.entryFee);
              if (tournament.organizer) details.push('**Organizer:** ' + tournament.organizer);
              if (tournament.waitlist && (tournament.registrations?.length || 0) >= tournament.limit) details.push('**Waitlist:** ' + (tournament.waitlistEntries?.length || 0) + ' waiting');
              embed.setDescription(details.join('\n'));
              if (tournament.thumbnail) embed.setThumbnail(tournament.thumbnail);
              if (tournament.image) embed.setImage(tournament.image);
              const customFields = String(tournament.fields || '').split('\n').map(line => line.split('|').map(value => value.trim())).filter(pair => pair.length >= 2 && pair[0] && pair[1]).slice(0, 20);
              for (const [name, value] of customFields) embed.addFields({ name: name.slice(0, 256), value: value.slice(0, 1024), inline: true });
              if (tournament.rules && tournament.showRules) embed.addFields({ name: '📜 Tournament Rules', value: tournament.rules.slice(0, 1024) });
              if (tournament.footer) embed.setFooter({ text: tournament.footer, ...(tournament.footerIcon ? { iconURL: tournament.footerIcon } : {}) });
              if (tournament.timestamp !== false) embed.setTimestamp(new Date());
              const buttons = [];
              if (tournament.teamMode) {
                buttons.push(new ButtonBuilder().setCustomId('tournament:teamcreate:' + tournament.id).setLabel('Create Team').setEmoji('🛡️').setStyle(ButtonStyle.Success).setDisabled(tournament.status !== 'registration'));
                buttons.push(new ButtonBuilder().setCustomId('tournament:teaminvite:' + tournament.id).setLabel('Invite Player').setEmoji('➕').setStyle(ButtonStyle.Primary).setDisabled(tournament.status !== 'registration'));
                buttons.push(new ButtonBuilder().setCustomId('tournament:teamleave:' + tournament.id).setLabel('Leave Team').setEmoji('🚪').setStyle(ButtonStyle.Danger));
              } else if (tournament.showJoin !== false) buttons.push(new ButtonBuilder().setCustomId('tournament:join:' + tournament.id).setLabel('Join Tournament').setEmoji('🏆').setStyle(ButtonStyle.Success).setDisabled(tournament.status !== 'registration' || ((tournament.registrations?.length || 0) >= tournament.limit && !tournament.waitlist)));
              if (tournament.showParticipants !== false) buttons.push(new ButtonBuilder().setCustomId('tournament:participants:' + tournament.id).setLabel('Participants').setEmoji('👥').setStyle(ButtonStyle.Secondary));
              if (tournament.showRules) buttons.push(new ButtonBuilder().setCustomId('tournament:rules:' + tournament.id).setLabel('Rules').setEmoji('📜').setStyle(ButtonStyle.Secondary));
              if (tournament.showCheckin) buttons.push(new ButtonBuilder().setCustomId('tournament:checkin:' + tournament.id).setLabel('Check-in').setEmoji('🎟️').setStyle(ButtonStyle.Primary).setDisabled(tournament.status !== 'live'));
              if (tournament.showLeave) buttons.push(new ButtonBuilder().setCustomId('tournament:leave:' + tournament.id).setLabel('Leave').setEmoji('❌').setStyle(ButtonStyle.Danger));
              const rows = [];
              for (let i = 0; i < buttons.length; i += 5) rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
              if (tournament.messageId && tournament.channelId) {
                const channel = await interaction.guild.channels.fetch(tournament.channelId).catch(() => null);
                const message = channel?.messages ? await channel.messages.fetch(tournament.messageId).catch(() => null) : null;
                if (message) await message.edit({ embeds: [embed], components: rows });
              }
            };

            if (action === 'teamleave') {
              const teams = Array.isArray(tournament.teams) ? tournament.teams : [];
              const team = teams.find(entry => entry.captainId === interaction.user.id || (entry.members || []).includes(interaction.user.id));
              if (!team) { await interaction.editReply({ content: 'You are not part of a team in this tournament.' }); return; }
              const ids = [team.captainId, ...(team.members || [])];
              if (team.captainId === interaction.user.id) {
                teams.splice(teams.indexOf(team), 1);
                tournament.registrations = (tournament.registrations || []).filter(entry => !ids.includes(entry.userId));
                tournament.checkedIn = (tournament.checkedIn || []).filter(id => !ids.includes(id));
              } else {
                team.members = (team.members || []).filter(id => id !== interaction.user.id);
                tournament.registrations = (tournament.registrations || []).filter(entry => entry.userId !== interaction.user.id);
                tournament.checkedIn = (tournament.checkedIn || []).filter(id => id !== interaction.user.id);
              }
              tournament.teams = teams;
              await client.db.set(key, tournaments);
              await interaction.editReply({ content: team.captainId === interaction.user.id ? 'Your team was disbanded and all its players were removed from the tournament.' : 'You left your team.' });
              return;
            }
            if (action === 'participants') {
              const { EmbedBuilder } = await import('discord.js');
              const participants = Array.isArray(tournament.registrations) ? tournament.registrations : [];
              const checked = new Set(tournament.checkedIn || []);
              const lines = tournament.teamMode ? (tournament.teams || []).map((team, index) => `**${index + 1}. ${team.name}** — Captain: <@${team.captainId}>\n${[team.captainId, ...(team.members || [])].map(id => '• <@' + id + '>' + (checked.has(id) ? ' ✅ Checked in' : '')).join('\n')}`) : participants.map((entry, index) => `**${index + 1}.** <@${entry.userId}>${checked.has(entry.userId) ? ' — ✅ Checked in' : ''}`);
              const embed = new EmbedBuilder().setColor(tournament.color || 0xC3F36B)
                .setTitle('👥 Participants — ' + tournament.name)
                .setDescription((lines.join('\n') || 'No one has registered yet.').slice(0, 4000))
                .setFooter({ text: participants.length + ' / ' + tournament.limit + ' registered' });
              await interaction.editReply({ embeds: [embed] });
              return;
            }
            if (action === 'rules') {
              await interaction.editReply({ content: tournament.rules || 'No tournament rules have been posted.' });
              return;
            }
            if (action === 'join') {
              if (tournament.status !== 'registration' || (tournament.deadline && Date.now() > Date.parse(tournament.deadline))) {
                await interaction.editReply({ content: 'Registration for this tournament is closed.' }); return;
              }
              if (!Array.isArray(tournament.registrations)) tournament.registrations = [];
              if (tournament.registrations.some(entry => entry.userId === interaction.user.id)) {
                await interaction.editReply({ content: 'You are already registered for **' + tournament.name + '**.' }); return;
              }
              if (tournament.registrations.length >= Number(tournament.limit)) {
                if (!tournament.waitlist) { await interaction.editReply({ content: 'This tournament is already full.' }); return; }
                if (!Array.isArray(tournament.waitlistEntries)) tournament.waitlistEntries = [];
                if (tournament.waitlistEntries.some(entry => entry.userId === interaction.user.id)) {
                  await interaction.editReply({ content: 'You are already on the waitlist.' }); return;
                }
                tournament.waitlistEntries.push({ userId: interaction.user.id, username: interaction.user.globalName || interaction.user.username, registeredAt: new Date().toISOString() });
                await client.db.set(key, tournaments);
                await refreshTournamentAnnouncement();
                await interaction.editReply({ content: '🕒 The tournament is full, but you have been added to the waitlist for **' + tournament.name + '**.' });
                return;
              }
              tournament.registrations.push({ userId: interaction.user.id, username: interaction.user.globalName || interaction.user.username, registeredAt: new Date().toISOString() });
              await client.db.set(key, tournaments);
              await refreshTournamentAnnouncement();
              await interaction.editReply({ content: '✅ You are registered for **' + tournament.name + '**! Good luck, soldier.' });
              return;
            }
            if (action === 'checkin') {
              if (tournament.status !== 'live') { await interaction.editReply({ content: 'Check-in is only available while the tournament is live.' }); return; }
              if (!(tournament.registrations || []).some(entry => entry.userId === interaction.user.id)) { await interaction.editReply({ content: 'You must register before checking in.' }); return; }
              if (!Array.isArray(tournament.checkedIn)) tournament.checkedIn = [];
              if (tournament.checkedIn.includes(interaction.user.id)) { await interaction.editReply({ content: 'You are already checked in.' }); return; }
              tournament.checkedIn.push(interaction.user.id);
              await client.db.set(key, tournaments);
              await refreshTournamentAnnouncement();
              await interaction.editReply({ content: '✅ Check-in confirmed for **' + tournament.name + '**!' });
              return;
            }
            if (action === 'leave') {
              const index = (tournament.registrations || []).findIndex(entry => entry.userId === interaction.user.id);
              if (index < 0) { await interaction.editReply({ content: 'You are not registered for this tournament.' }); return; }
              tournament.registrations.splice(index, 1);
              if (Array.isArray(tournament.checkedIn)) tournament.checkedIn = tournament.checkedIn.filter(id => id !== interaction.user.id);
              if (tournament.waitlist && tournament.waitlistEntries?.length) {
                const next = tournament.waitlistEntries.shift();
                tournament.registrations.push(next);
              }
              await client.db.set(key, tournaments);
              await refreshTournamentAnnouncement();
              await interaction.editReply({ content: 'Your registration for **' + tournament.name + '** has been cancelled.' });
              return;
            }
            await interaction.editReply({ content: 'Unknown tournament action.' });
            return;
          }
          if (interaction.customId === 'barracks_nickname_change') {
            await handleNicknameChangeButton(interaction);
            return;
          }
          if (interaction.customId === 'clan:leader:addmember' || interaction.customId === 'clan:leader:kickmember') {
            const clans = await interaction.client.db.get('guild:' + interaction.guildId + ':clans', []);
            const clan = (Array.isArray(clans) ? clans : []).find(entry => entry.status === 'approved' &&
              [String(entry.leaderId || ''), String(entry.viceLeaderId || '')].includes(interaction.user.id));
            if (!clan) {
              await interaction.reply({ content: 'Only the Clan Leader or Vice Clan Leader of an approved clan can manage members.', flags: MessageFlags.Ephemeral });
              return;
            }
            const isAdd = interaction.customId.endsWith('addmember');
            const { ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle } = await import('discord.js');
            const modal = new ModalBuilder()
              .setCustomId('clan:leader:' + (isAdd ? 'addmember' : 'kickmember') + ':submit')
              .setTitle(isAdd ? 'Add Clan Member' : 'Remove Clan Member')
              .addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId('member_id')
                  .setLabel('Member mention or Discord ID')
                  .setPlaceholder('@member or 123456789012345678')
                  .setStyle(TextInputStyle.Short)
                  .setRequired(true)
                  .setMaxLength(30)
              ));
            await interaction.showModal(modal);
            return;
          }
          if (interaction.customId.startsWith('clan:leader:')) {
            const action = interaction.customId.split(':')[2];
            const clans = await interaction.client.db.get(`guild:${interaction.guildId}:clans`, []);
            const clan = (Array.isArray(clans) ? clans : []).find(entry =>
              entry.status === 'approved' &&
              [String(entry.leaderId || ''), String(entry.viceLeaderId || '')].includes(interaction.user.id)
            );
            if (!clan) {
              await interaction.reply({ content: 'This panel is for the Clan Leader and Vice Clan Leader of an approved clan only.', flags: MessageFlags.Ephemeral });
              return;
            }
            const { EmbedBuilder } = await import('discord.js');
            const color = /^#?[0-9a-fA-F]{6}$/.test(String(clan.roleHex || '')) ? Number.parseInt(String(clan.roleHex).replace('#', ''), 16) : 0xD4A017;
            let embed;
            if (action === 'members') {
              const members = Array.isArray(clan.memberIds) ? clan.memberIds : [];
              embed = new EmbedBuilder().setColor(color).setTitle(`👥 ${clan.name} [${clan.tag}] — Roster`)
                .setDescription([`👑 **Clan Leader:** <@${clan.leaderId}>`, `🛡️ **Vice Clan Leader:** <@${clan.viceLeaderId || '0'}>`, ...members.map(id => `• <@${id}>`)].join('\n'))
                .setFooter({ text: `Total members: ${members.length + 2} • Barracks` });
            } else if (action === 'bank') {
              const balance = Math.max(0, Number(clan.bankBalance) || 0);
              embed = new EmbedBuilder().setColor(color).setTitle(`🏦 ${clan.name} [${clan.tag}] — Clan Bank`)
                .setDescription(`**Available Clan Funds**\n₱${balance.toLocaleString()}\n\nThis is your clan's shared treasury.`)
                .setFooter({ text: 'Barracks • Clan Treasury' });
            } else if (action === 'transactions') {
              const transactions = (Array.isArray(clan.bankTransactions) ? clan.bankTransactions : []).slice(-10).reverse();
              const lines = transactions.map(tx => `${tx.type === 'deposit' ? '📥' : '📤'} **₱${Number(tx.amount || 0).toLocaleString()}** — ${tx.type} by <@${tx.userId}> • ${tx.createdAt ? new Date(tx.createdAt).toLocaleString() : 'Unknown date'}`);
              embed = new EmbedBuilder().setColor(color).setTitle(`📜 ${clan.name} — Bank Transactions`)
                .setDescription(lines.length ? lines.join('\n') : 'No transactions recorded yet.')
                .setFooter({ text: 'Showing the latest 10 transactions' });
            } else if (action === 'requests') {
              const pending = (Array.isArray(clan.joinRequests) ? clan.joinRequests : []).filter(request => request.status === 'pending');
              embed = new EmbedBuilder().setColor(color).setTitle(`📨 ${clan.name} — Join Requests`)
                .setDescription(pending.length ? pending.map(request => `• <@${request.userId}> — submitted ${request.createdAt ? new Date(request.createdAt).toLocaleString() : 'date unavailable'}`).join('\n') : 'There are no pending join requests. Accept or decline applications from the request messages sent to leadership DMs.')
                .setFooter({ text: `Pending applications: ${pending.length}` });
            } else if (action === 'settings') {
              embed = new EmbedBuilder().setColor(color).setTitle(`⚙️ ${clan.name} [${clan.tag}] — Clan Details`)
                .setDescription(clan.description || 'No clan description has been set.')
                .addFields(
                  { name: 'Clan Leader', value: `<@${clan.leaderId}>`, inline: true },
                  { name: 'Vice Clan Leader', value: clan.viceLeaderId ? `<@${clan.viceLeaderId}>` : 'Not assigned', inline: true },
                  { name: 'Roster Size', value: String((Array.isArray(clan.memberIds) ? clan.memberIds.length : 0) + 2), inline: true },
                  { name: 'Clan Rules', value: clan.rules || 'No clan rules have been added.' }
                );
            } else {
              await interaction.reply({ content: 'That panel action is not available.', flags: MessageFlags.Ephemeral });
              return;
            }
            await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
            return;
          }
          if (interaction.customId.startsWith('clan:member:')) {
            const action = interaction.customId.split(':')[2];
            const clans = await interaction.client.db.get(`guild:${interaction.guildId}:clans`, []);
            const clan = (Array.isArray(clans) ? clans : []).find(entry =>
              entry.status === 'approved' &&
              [String(entry.leaderId || ''), String(entry.viceLeaderId || ''), ...(Array.isArray(entry.memberIds) ? entry.memberIds.map(String) : [])].includes(interaction.user.id)
            );
            if (!clan) {
              await interaction.reply({ content: 'You must be a member of an approved clan to use the Clan Member Panel.', flags: MessageFlags.Ephemeral });
              return;
            }
            const { EmbedBuilder } = await import('discord.js');
            const color = /^#?[0-9a-fA-F]{6}$/.test(String(clan.roleHex || '')) ? Number.parseInt(String(clan.roleHex).replace('#', ''), 16) : 0x5865F2;
            const members = Array.isArray(clan.memberIds) ? clan.memberIds : [];
            let embed;
            if (action === 'details') {
              embed = new EmbedBuilder().setColor(color).setTitle(`🏰 ${clan.name} [${clan.tag}] — Clan Details`)
                .setDescription(clan.description || 'No clan description has been set.')
                .addFields(
                  { name: '👑 Clan Leader', value: `<@${clan.leaderId}>`, inline: true },
                  { name: '🛡️ Vice Clan Leader', value: clan.viceLeaderId ? `<@${clan.viceLeaderId}>` : 'Not assigned', inline: true },
                  { name: '👥 Roster Size', value: String(members.length + 2), inline: true }
                );
            } else if (action === 'members') {
              embed = new EmbedBuilder().setColor(color).setTitle(`👥 ${clan.name} [${clan.tag}] — Members`)
                .setDescription([`👑 **Clan Leader:** <@${clan.leaderId}>`, `🛡️ **Vice Clan Leader:** ${clan.viceLeaderId ? `<@${clan.viceLeaderId}>` : 'Not assigned'}`, ...members.map(id => `• <@${id}>`)].join('\n'))
                .setFooter({ text: `Total roster: ${members.length + 2} • Barracks` });
            } else if (action === 'bank') {
              const balance = Math.max(0, Number(clan.bankBalance) || 0);
              embed = new EmbedBuilder().setColor(color).setTitle(`🏦 ${clan.name} [${clan.tag}] — Clan Bank`)
                .setDescription(`**Available Clan Funds**\n₱${balance.toLocaleString()}\n\nThis is your clan's shared treasury. Only the Clan Leader and Vice Clan Leader can deposit or withdraw funds.`)
                .setFooter({ text: 'Barracks • Clan Treasury' });
            } else if (action === 'rules') {
              embed = new EmbedBuilder().setColor(color).setTitle(`📜 ${clan.name} [${clan.tag}] — Clan Rules`)
                .setDescription(clan.rules || 'No clan rules have been added.');
            } else {
              await interaction.reply({ content: 'That panel action is not available.', flags: MessageFlags.Ephemeral });
              return;
            }
            await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
            return;
          }
          if (interaction.customId === 'clan:bank:view') {
            const clans = await interaction.client.db.get(`guild:${interaction.guildId}:clans`, []);
            const clan = (Array.isArray(clans) ? clans : []).find(entry =>
              entry.status === 'approved' &&
              [String(entry.leaderId || ''), String(entry.viceLeaderId || ''), ...(Array.isArray(entry.memberIds) ? entry.memberIds.map(String) : [])].includes(interaction.user.id)
            );
            if (!clan) {
              await interaction.reply({ content: 'You must be a member of an approved clan to view its bank.', flags: MessageFlags.Ephemeral });
              return;
            }
            const { EmbedBuilder } = await import('discord.js');
            const balance = Math.max(0, Number(clan.bankBalance) || 0);
            const color = /^#?[0-9a-fA-F]{6}$/.test(String(clan.roleHex || '')) ? Number.parseInt(String(clan.roleHex).replace('#', ''), 16) : 0x5865F2;
            const embed = new EmbedBuilder()
              .setColor(color)
              .setTitle(`🏦 ${clan.name} [${clan.tag}] — Clan Bank`)
              .setDescription(`**Available Clan Funds**\\n₱${balance.toLocaleString()}\\n\\nThis is your clan's shared treasury. Only the Clan Leader and Vice Clan Leader can deposit or withdraw funds.`)
              .setFooter({ text: 'Barracks • Clan Treasury' })
              .setTimestamp();
            await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
            return;
          }
          if (interaction.customId === 'clan:create:continue') {
            const draftKey = `guild:${interaction.guildId}:clan_create_draft:${interaction.user.id}`;
            const draft = await interaction.client.db.get(draftKey, null);
            if (!draft || Date.now() - draft.createdAt > 30 * 60 * 1000) {
              await interaction.client.db.delete(draftKey).catch(() => {});
              await interaction.reply({ content: 'Your clan creation session expired. Please open the Create a Clan panel again.', flags: MessageFlags.Ephemeral });
              return;
            }
            const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');
            const continueRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId('clan:create:continue')
                .setLabel('Continue to Clan Rules & Logo')
                .setStyle(ButtonStyle.Primary)
            );
            await interaction.reply({
              content: 'Your clan details have been saved for this session. Click below to continue to **Clan Rules** and **Clan Logo**.',
              components: [continueRow],
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          if (interaction.customId.startsWith('barracksLotto:')) {
            const { handleLottoButton } = await import('../services/barracksLottoService.js');
            await handleLottoButton(interaction, client);
            return;
          }
          if (interaction.customId.startsWith('bankUpgrade:buy:')) {
            const [, , guildId, packageKey] = interaction.customId.split(':');
            if (!interaction.guild || interaction.guildId !== guildId) {
              await interaction.reply({ content: 'This bank upgrade panel belongs to another server.', flags: MessageFlags.Ephemeral });
              return;
            }
            const packages = botConfig.economy?.bankUpgradePackages || {};
            const upgrade = packageKey === 'single' ? packages.single : null;
            if (!upgrade || !Number.isSafeInteger(upgrade.capacity) || !Array.isArray(upgrade.priceTiers) || upgrade.priceTiers.length === 0 || upgrade.priceTiers.some((tier) => !Number.isSafeInteger(tier.through) || !Number.isSafeInteger(tier.price) || tier.price < 0)) {
              await interaction.reply({ content: 'That bank upgrade is unavailable.', flags: MessageFlags.Ephemeral });
              return;
            }
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const economy = await getEconomyData(client, guildId, interaction.user.id);
            const currentLimit = getMaxBankCapacity(economy);
            const maxLimit = Number(botConfig.economy?.maxBankCapacity) || 100000000;
            if (currentLimit + upgrade.capacity > maxLimit) {
              await interaction.editReply(`This upgrade would exceed the overall bank limit. Your current limit is **₱${currentLimit.toLocaleString()}** and the maximum is **₱${maxLimit.toLocaleString()}**. Choose a smaller package.`);
              return;
            }
            const wallet = Number(economy.wallet) || 0;
            const priorPurchases = Math.floor(Math.max(0, Number(economy.bankUpgradeCapacity) || 0) / upgrade.capacity);
            const purchaseNumber = priorPurchases + 1;
            const priceTier = (upgrade.priceTiers || []).find((tier) => purchaseNumber <= tier.through);
            if (!priceTier) {
              await interaction.editReply('The bank upgrade purchase limit has been reached. Please contact an administrator.');
              return;
            }
            const purchasePrice = priceTier.price;
            if (wallet < purchasePrice) {
              await interaction.editReply(`Not enough Bcash in your wallet.\nPurchase #${purchaseNumber} price: **₱${purchasePrice.toLocaleString()}**\nYour wallet: **₱${wallet.toLocaleString()}**`);
              return;
            }
            economy.wallet = wallet - purchasePrice;
            economy.bankUpgradeCapacity = Math.max(0, Number(economy.bankUpgradeCapacity) || 0) + upgrade.capacity;
            const saved = await setEconomyData(client, guildId, interaction.user.id, economy);
            if (!saved) {
              await interaction.editReply('The purchase could not be saved. No bank upgrade was applied.');
              return;
            }
            const newLimit = getMaxBankCapacity(economy);
            const avatarUrl = interaction.user.displayAvatarURL({ extension: 'png', size: 256 });
            await interaction.editReply({
              embeds: [{
                color: 0xD4A017,
                author: {
                  name: `BANK UPGRADE • @${interaction.user.username}`,
                },
                title: '🏦 Bank Capacity Increased!',
                description: [
                  'Your purchase was successful.',
                  '',
                  '**NEW BANK CAPACITY**',
                  `# ₱${newLimit.toLocaleString()}`,
                ].join('\n'),
                thumbnail: { url: avatarUrl },
                fields: [{
                  name: '📋 Transaction Details',
                  value: [
                    `**Capacity Added**  ·  +₱${upgrade.capacity.toLocaleString()}`,
                    `**Purchase Cost**  ·  ₱${purchasePrice.toLocaleString()}`,
                    `**Remaining Wallet**  ·  ₱${economy.wallet.toLocaleString()}`,
                  ].join('\n'),
                  inline: false,
                }],
                footer: { text: 'BARRACKS  •  BANK UPGRADE DEPOT  •  PRIVATE CONFIRMATION' },
                timestamp: new Date().toISOString(),
              }],
            });
            return;
          }
          if (interaction.customId.startsWith('rolepanel:toggle:')) {
            const [, , guildId, roleId] = interaction.customId.split(':');
            if (!interaction.guild || interaction.guildId !== guildId) {
              await interaction.reply({ content: 'This role panel belongs to another server.', flags: MessageFlags.Ephemeral });
              return;
            }
            const rolePanelConfig = await getGuildConfig(client, guildId, interactionTraceContext);
            const configuredRoles = Array.isArray(rolePanelConfig?.rolePanelRoles) && rolePanelConfig.rolePanelRoles.length
              ? rolePanelConfig.rolePanelRoles
              : await client.db.get(`guild:${guildId}:rolePanelRoles`, []);
            const configured = Array.isArray(configuredRoles) ? configuredRoles.find(item => String(item?.role) === roleId) : null;
            if (!configured) {
              await interaction.reply({ content: 'This role is no longer configured in the role panel.', flags: MessageFlags.Ephemeral });
              return;
            }
            const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
            const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe();
            if (!role || role.id === guildId || role.managed || role.position >= botMember.roles.highest.position ||
                role.permissions.toArray().some(permission => ['Administrator', 'ManageGuild', 'ManageRoles', 'BanMembers', 'KickMembers', 'ManageChannels', 'ManageWebhooks', 'MentionEveryone'].includes(permission))) {
              await interaction.reply({ content: 'This role cannot be self-assigned. Please contact a server administrator.', flags: MessageFlags.Ephemeral });
              return;
            }
            if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
              await interaction.reply({ content: 'I need Manage Roles permission to assign this role.', flags: MessageFlags.Ephemeral });
              return;
            }
            const member = await interaction.guild.members.fetch(interaction.user.id);
            try {
              if (member.roles.cache.has(roleId)) {
                await member.roles.remove(role, 'Self-removed role from Barracks role panel');
                await interaction.reply({ content: `Removed <@&${roleId}>`, flags: MessageFlags.Ephemeral });
              } else {
                await member.roles.add(role, 'Self-assigned role from Barracks role panel');
                await interaction.reply({ content: `You now have <@&${roleId}>`, flags: MessageFlags.Ephemeral });
              }
            } catch (error) {
              logger.error('Role panel toggle failed:', { guildId, userId: interaction.user.id, roleId, error: error.message });
              await interaction.reply({ content: 'I could not update your role. Please check my Manage Roles permission and role hierarchy.', flags: MessageFlags.Ephemeral }).catch(() => {});
            }
            return;
          }

          if (interaction.customId.startsWith('bcal:')) {
            const [, action, guildId, month] = interaction.customId.split(':');
            if (!interaction.guild || interaction.guildId !== guildId) {
              await interaction.reply({ content: 'This Barracks Calendar belongs to another server.', flags: MessageFlags.Ephemeral });
              return;
            }
            let targetMonth = parseCalendarMonth(month);
            if (action === 'prev') targetMonth.setUTCMonth(targetMonth.getUTCMonth() - 1);
            else if (action === 'next') targetMonth.setUTCMonth(targetMonth.getUTCMonth() + 1);
            else if (action === 'today') targetMonth = new Date();
            else {
              await interaction.reply({ content: 'That calendar control is not recognized.', flags: MessageFlags.Ephemeral });
              return;
            }
            const events = await getCalendarEvents(client, guildId);
            await interaction.update(buildCalendarPayload(interaction.guild, events, targetMonth));
            return;
          }
          if (interaction.customId.startsWith('roleShopBoosterColor:page:')) {
            const [, , guildId, pageText] = interaction.customId.split(':');
            const page = Number.parseInt(pageText, 10);
            if (!interaction.guild || interaction.guildId !== guildId || !Number.isInteger(page) || page < 0) {
              await interaction.reply({ content: 'This booster color shop page is invalid.', flags: MessageFlags.Ephemeral });
              return;
            }
            const items = await getBShopBoosterColorItems(interaction.client, guildId);
            await interaction.update({ components: [buildBoosterColorShopPage(items, interaction.guild, page)], flags: MessageFlags.IsComponentsV2 });
            return;
          }

          if (interaction.customId.startsWith('roleShopColor:page:')) {
            const [, , guildId, pageText] = interaction.customId.split(':');
            const page = Number.parseInt(pageText, 10);
            if (!interaction.guild || interaction.guildId !== guildId || !Number.isInteger(page) || page < 0) {
              await interaction.reply({ content: 'This color shop page is invalid.', flags: MessageFlags.Ephemeral });
              return;
            }
            const items = await getBShopColorItems(interaction.client, guildId);
            await interaction.update({ components: [buildColorShopPage(items, interaction.guild, page)], flags: MessageFlags.IsComponentsV2 });
            return;
          }

          if (interaction.customId.startsWith('clanShop:page:')) {
            const [, , guildId, pageText] = interaction.customId.split(':');
            const page = Number.parseInt(pageText, 10);
            if (!interaction.guild || interaction.guildId !== guildId || !Number.isInteger(page) || page < 0) {
              await interaction.reply({ content: 'This Clan Shop page is invalid.', flags: MessageFlags.Ephemeral });
              return;
            }
            const items = await getClanShopItems(interaction.client, guildId);
            await interaction.update({ components: [buildClanShopPage(items, guildId, page)], flags: MessageFlags.IsComponentsV2 });
            return;
          }

          if (interaction.customId.startsWith('clanShop:buy:')) {
            const [, , guildId, roleId] = interaction.customId.split(':');
            if (!interaction.guild || interaction.guildId !== guildId) {
              await interaction.reply({ content: 'This shop belongs to another server.', flags: MessageFlags.Ephemeral });
              return;
            }
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            if (roleId === 'member-expansion') {
              const clanKey = 'guild:' + guildId + ':clans';
              const storedClans = await interaction.client.db.get(clanKey, []);
              const clanList = Array.isArray(storedClans) ? storedClans : [];
              const clan = clanList.find(entry => entry.status === 'approved' &&
                [String(entry.leaderId || ''), String(entry.viceLeaderId || '')].includes(interaction.user.id));
              if (!clan) {
                await interaction.editReply('Only the Clan Leader or Vice Clan Leader of an approved clan can purchase a member expansion.');
                return;
              }
              const currentLimit = Math.min(200, Math.max(10, Number(clan.maxMembers) || 10));
              if (currentLimit >= 200) {
                await interaction.editReply('Your clan has reached the maximum capacity of 200 members.');
                return;
              }
              const nextLimit = Math.min(200, currentLimit + 10);
              const price = 1000000;
              const economy = await getEconomyData(interaction.client, guildId, interaction.user.id);
              const wallet = Number(economy?.wallet) || 0;
              if (wallet < price) {
                await interaction.editReply('This expansion costs ' + price.toLocaleString() + ' bCash. Your wallet has ' + wallet.toLocaleString() + ' bCash.');
                return;
              }
              const paid = await removeMoney(interaction.client, guildId, interaction.user.id, price, 'wallet');
              if (paid === false) {
                await interaction.editReply('The payment could not be processed. No clan expansion was applied.');
                return;
              }
              clan.maxMembers = nextLimit;
              clan.memberExpansionPurchasedAt = Date.now();
              clan.memberExpansionPurchasedBy = interaction.user.id;
              await interaction.client.db.set(clanKey, clanList);
              const updated = await getEconomyData(interaction.client, guildId, interaction.user.id);
              await interaction.editReply('Clan **' + clan.name + ' [' + clan.tag + ']** has been expanded!\nNew capacity: **' + nextLimit + ' members** (including leadership).\nPaid: **' + price.toLocaleString() + ' bCash**\nRemaining wallet: **' + (Number(updated?.wallet) || 0).toLocaleString() + ' bCash**.');
              return;
            }
            const items = await getClanShopItems(interaction.client, guildId);
            const item = items.find(entry => entry.roleId === roleId);
            const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
            if (!item || !role || role.managed || role.id === guildId) {
              await interaction.editReply('That role is no longer available to purchase.');
              return;
            }
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (member.roles.cache.has(roleId)) {
              await interaction.editReply('You already own this role.');
              return;
            }
            const botMember = interaction.guild.members.me || await interaction.guild.members.fetch(interaction.client.user.id);
            if (!botMember.permissions.has('ManageRoles') || role.position >= botMember.roles.highest.position) {
              await interaction.editReply('I cannot assign this role. Ask the server owner to move my role above it and enable Manage Roles.');
              return;
            }
            const economy = await getEconomyData(interaction.client, guildId, interaction.user.id);
            const wallet = Number(economy?.wallet) || 0;
            if (wallet < item.price) {
              await interaction.editReply(`You need **${item.price.toLocaleString()} bCash**, but you only have **${wallet.toLocaleString()} bCash** in your wallet.`);
              return;
            }
            await removeMoney(interaction.client, guildId, interaction.user.id, item.price, 'wallet');
            const removedColorRoles = [];
            try {
              await member.roles.add(role, 'Clan Shop role purchase');
            } catch (error) {
              await addMoney(interaction.client, guildId, interaction.user.id, item.price, 'wallet').catch(() => {});
              logger.error('Clan Shop role assignment failed.', { guildId, userId: interaction.user.id, roleId, error: error.message });
              await interaction.editReply('Role assignment failed, so your bCash was refunded.');
              return;
            }
            const updated = await getEconomyData(interaction.client, guildId, interaction.user.id);
            await interaction.editReply(`✅ You purchased ${role} for **${item.price.toLocaleString()} bCash**. Remaining wallet: **${(Number(updated?.wallet) || 0).toLocaleString()} bCash**.`);
            return;
          }

          if (interaction.customId.startsWith('roleShop:buy:') || interaction.customId.startsWith('roleShopColor:buy:') || interaction.customId.startsWith('roleShopBoosterColor:buy:')) {
            const [, , guildId, roleId] = interaction.customId.split(':');
            if (!interaction.guild || interaction.guildId !== guildId) {
              await interaction.reply({ content: 'This shop belongs to another server.', flags: MessageFlags.Ephemeral });
              return;
            }
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const isBoosterColorPurchase = interaction.customId.startsWith('roleShopBoosterColor:buy:');
            const isColorPurchase = interaction.customId.startsWith('roleShopColor:buy:');
            const items = isBoosterColorPurchase
              ? await getBShopBoosterColorItems(interaction.client, guildId)
              : isColorPurchase
                ? await getBShopColorItems(interaction.client, guildId)
                : await getBShopItems(interaction.client, guildId);
            const item = items.find(entry => entry.roleId === roleId);
            const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
            if (!item || !role || role.managed || role.id === guildId) {
              await interaction.editReply('That role is no longer available to purchase.');
              return;
            }
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (isBoosterColorPurchase && !member.roles.cache.has('1325060414752428136')) {
              await interaction.editReply('💎 Boost the server to purchase exclusive color roles.');
              return;
            }
            if (member.roles.cache.has(roleId)) {
              await interaction.editReply('You already own this role.');
              return;
            }
            const botMember = interaction.guild.members.me || await interaction.guild.members.fetch(interaction.client.user.id);
            if (!botMember.permissions.has('ManageRoles') || role.position >= botMember.roles.highest.position) {
              await interaction.editReply('I cannot assign this role. Ask the server owner to move my role above it and enable Manage Roles.');
              return;
            }
            const economy = isBoosterColorPurchase ? null : await getEconomyData(interaction.client, guildId, interaction.user.id);
            const wallet = Number(economy?.wallet) || 0;
            if (!isBoosterColorPurchase && wallet < item.price) {
              await interaction.editReply(`You need **${item.price.toLocaleString()} bCash**, but you only have **${wallet.toLocaleString()} bCash** in your wallet.`);
              return;
            }
            if (!isBoosterColorPurchase) {
              await removeMoney(interaction.client, guildId, interaction.user.id, item.price, 'wallet');
            }
            const removedColorRoles = [];
            try {
              if (isColorPurchase || isBoosterColorPurchase) {
                const [regularColorItems, boosterColorItems] = await Promise.all([
                  getBShopColorItems(interaction.client, guildId),
                  getBShopBoosterColorItems(interaction.client, guildId),
                ]);
                const otherColorRoleIds = [...new Set([...regularColorItems, ...boosterColorItems]
                  .map(entry => entry.roleId)
                  .filter(id => id !== roleId && member.roles.cache.has(id)))];
                for (const otherRoleId of otherColorRoleIds) {
                  const otherRole = interaction.guild.roles.cache.get(otherRoleId)
                    || await interaction.guild.roles.fetch(otherRoleId).catch(() => null);
                  if (otherRole && otherRole.color !== 0) removedColorRoles.push(otherRole);
                }
                if (removedColorRoles.length) {
                  await member.roles.remove(removedColorRoles, 'Replaced by another B-Shop color role');
                }
              }
              await member.roles.add(role, 'B-Shop role purchase');
            } catch (error) {
              if (removedColorRoles.length) {
                await member.roles.add(removedColorRoles, 'Restore previous B-Shop color roles after failed purchase').catch(restoreError => {
                  logger.error('Could not restore previous B-Shop color roles after failed purchase.', { guildId, userId: interaction.user.id, error: restoreError.message });
                });
              }
              if (!isBoosterColorPurchase) {
                await addMoney(interaction.client, guildId, interaction.user.id, item.price, 'wallet').catch(() => {});
              }
              logger.error('B-Shop role assignment failed.', { guildId, userId: interaction.user.id, roleId, error: error.message });
              await interaction.editReply(isBoosterColorPurchase
                ? 'Role assignment failed. Please try again or contact a server admin.'
                : 'Role assignment failed, so your bCash was refunded.');
              return;
            }
            if (isBoosterColorPurchase) {
              await interaction.editReply(`✅ You picked ${role}! Thank you for boosting Barracks <a:Soldier:1565287699965812837>`);
            } else {
              const updated = await getEconomyData(interaction.client, guildId, interaction.user.id);
              await interaction.editReply(`✅ You purchased ${role} for **${item.price.toLocaleString()} bCash**. Remaining wallet: **${(Number(updated?.wallet) || 0).toLocaleString()} bCash**.`);
            }
            return;
          }


          if (interaction.customId === 'clan:leave:open') {
            const storageKey = `guild:${interaction.guildId}:clans`;
            const clans = await interaction.client.db.get(storageKey, []);
            const clanList = Array.isArray(clans) ? clans : [];
            const clan = clanList.find(entry => entry.status === 'approved' &&
              [entry.leaderId, entry.viceLeaderId, ...(Array.isArray(entry.memberIds) ? entry.memberIds : [])].includes(interaction.user.id));
            if (!clan) {
              await interaction.reply({ content: 'You are not currently a member of an approved clan.', flags: MessageFlags.Ephemeral });
              return;
            }
            if (clan.leaderId === interaction.user.id) {
              await interaction.reply({ content: 'You are the Clan Leader. Transfer leadership or remove your clan using **/clan delete** before leaving.', flags: MessageFlags.Ephemeral });
              return;
            }
            const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = await import('discord.js');
            const confirmEmbed = new EmbedBuilder()
              .setColor(0xED4245)
              .setTitle('🚪 Leave Your Clan?')
              .setDescription(`Are you sure you want to leave **${clan.name} [${clan.tag}]**? Your clan role and nickname tag will be removed.`);
            const row = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`clan:leave:confirm:${interaction.user.id}`).setLabel('Confirm Leave').setEmoji('🚪').setStyle(ButtonStyle.Danger),
              new ButtonBuilder().setCustomId(`clan:leave:cancel:${interaction.user.id}`).setLabel('Keep My Clan').setStyle(ButtonStyle.Secondary)
            );
            await interaction.reply({ embeds: [confirmEmbed], components: [row], flags: MessageFlags.Ephemeral });
            return;
          }

          if (interaction.customId.startsWith('clan:leave:')) {
            const [, , action, ownerId] = interaction.customId.split(':');
            if (interaction.user.id !== ownerId) {
              await interaction.reply({ content: 'Only the member who opened this confirmation can use these buttons.', flags: MessageFlags.Ephemeral });
              return;
            }
            if (action === 'cancel') {
              await interaction.update({ content: 'No changes made. You are still in your clan.', embeds: [], components: [] });
              return;
            }
            if (action === 'confirm') {
              const storageKey = `guild:${interaction.guildId}:clans`;
              const clans = await interaction.client.db.get(storageKey, []);
              const clanList = Array.isArray(clans) ? clans : [];
              const memberships = clanList.filter(entry => entry.status === 'approved' &&
                entry.leaderId !== interaction.user.id &&
                (String(entry.viceLeaderId || '') === interaction.user.id ||
                  (Array.isArray(entry.memberIds) && entry.memberIds.map(String).includes(interaction.user.id))));
              if (!memberships.length) {
                await interaction.update({ content: 'You are no longer listed as a member of an approved clan.', embeds: [], components: [] });
                return;
              }
              const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
              if (!member) {
                await interaction.update({ content: 'I could not find your server membership. Your clan membership is unchanged; please try again.', embeds: [], components: [] });
                return;
              }
              try {
                for (const clan of memberships) {
                  if (clan.roleId && member.roles.cache.has(clan.roleId)) {
                    await member.roles.remove(clan.roleId, `Left clan ${clan.name}`);
                  }
                }
              } catch (error) {
                logger.warn(`Could not remove clan role from ${member.id}: ${error.message}`);
                await interaction.update({ content: 'I could not remove your clan role. Your clan membership is unchanged. Please contact staff to check the bot role hierarchy.', embeds: [], components: [] });
                return;
              }
              for (const clan of memberships) {
                clan.memberIds = (Array.isArray(clan.memberIds) ? clan.memberIds : []).filter(id => String(id) !== interaction.user.id);
                if (String(clan.viceLeaderId || '') === interaction.user.id) clan.viceLeaderId = null;
              }
              await interaction.client.db.set(storageKey, clanList);
              await applyHighestPriorityAutoNick(member).catch(error => {
                logger.warn(`Could not apply highest-priority AutoNick for ${member.id} after leaving clan: ${error.message}`);
              });
              const leftNames = memberships.map(clan => `**${clan.name} [${clan.tag}]**`).join(', ');
              await interaction.update({ content: `✅ You have left ${leftNames}. Your clan role(s) and clan nickname tag(s) have been removed.`, embeds: [], components: [] });
              return;
            }
          }

          if (interaction.customId === 'clan:join:open') {
            const { ActionRowBuilder, StringSelectMenuBuilder } = await import('discord.js');
            const clans = await interaction.client.db.get(`guild:${interaction.guildId}:clans`, []);
            const approved = (Array.isArray(clans) ? clans : []).filter(clan => clan.status === 'approved' && clan.roleId);
            if (!approved.length) {
              await interaction.reply({ content: 'There are currently no approved clans available to join.', flags: MessageFlags.Ephemeral });
              return;
            }
            // Resolve leader display names from Discord instead of relying only on cached members.
            const leaderNames = new Map();
            await Promise.all(approved.map(async clan => {
              const leaderId = String(clan.leaderId || '');
              if (!leaderId) return;
              const leader = await interaction.guild.members.fetch(leaderId).catch(() => null);
              const displayName = leader?.displayName || clan.leaderName || 'Unknown Leader';
              leaderNames.set(leaderId, displayName);
            }));
            const options = approved.slice(0, 25).map(clan => {
              const leaderName = leaderNames.get(String(clan.leaderId || '')) || clan.leaderName || 'Unknown Leader';
              return {
                label: `${clan.name} [${clan.tag}]`.slice(0, 100),
                description: `Clan Leader: ${leaderName}`.slice(0, 100),
                value: String(clan.id || clan.roleId),
                emoji: '🏰',
              };
            });
            const menu = new StringSelectMenuBuilder()
              .setCustomId('clan:join:select')
              .setPlaceholder('Choose an approved clan')
              .addOptions(options);
            await interaction.reply({
              content: 'Select the clan you want to apply to join. The Clan Leader or Vice Clan Leader must approve your application.',
              components: [new ActionRowBuilder().addComponents(menu)],
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          if (interaction.customId === 'clan:create:continue') {
            const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');
            const continueButton = new ButtonBuilder()
              .setCustomId('clan:create:continue')
              .setLabel('Continue to Step 2')
              .setStyle(ButtonStyle.Primary);
            await interaction.reply({
              content: '✅ Step 1 completed. Continue to add your Clan Rules and upload your Clan Logo.',
              components: [new ActionRowBuilder().addComponents(continueButton)],
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          if (interaction.customId === 'clan:create') {
            const { ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle } = await import('discord.js');
            const modal = new ModalBuilder()
              .setCustomId('clan:create:step1')
              .setTitle('Create a Clan')
              .addLabelComponents(
                new LabelBuilder()
                  .setLabel('Clan Name')
                  .setDescription('Letters, numbers, symbols, and emojis are allowed. Use any combination you like.')
                  .setTextInputComponent(new TextInputBuilder().setCustomId('clan_name').setStyle(TextInputStyle.Short).setMaxLength(32).setRequired(true)),
                new LabelBuilder()
                  .setLabel('Clan Tag')
                  .setDescription('Letters, numbers, symbols, and emojis are allowed.')
                  .setTextInputComponent(new TextInputBuilder().setCustomId('clan_tag').setStyle(TextInputStyle.Short).setPlaceholder('★').setMaxLength(100).setRequired(true)),
                new LabelBuilder()
                  .setLabel('Role Hex')
                  .setDescription('Six-digit color code, for example #5865F2.')
                  .setTextInputComponent(new TextInputBuilder().setCustomId('clan_role_hex').setStyle(TextInputStyle.Short).setPlaceholder('#5865F2').setMaxLength(7).setRequired(true)),
                new LabelBuilder()
                  .setLabel('Vice Clan Leader')
                  .setDescription('Mention the member or enter their Discord user ID.')
                  .setTextInputComponent(new TextInputBuilder().setCustomId('clan_vice_leader').setStyle(TextInputStyle.Short).setMaxLength(25).setRequired(true))
              );
            await interaction.showModal(modal);
            return;
          }

          if (interaction.customId.startsWith('clan:join:decision:')) {
            const [, , , decision, guildId, requestId] = interaction.customId.split(':');
            const guild = await interaction.client.guilds.fetch(guildId).catch(() => null);
            if (!guild) {
              await interaction.reply({ content: 'The server for this application could not be found.', flags: MessageFlags.Ephemeral });
              return;
            }
            const storageKey = `guild:${guildId}:clans`;
            const clans = await interaction.client.db.get(storageKey, []);
            const clanList = Array.isArray(clans) ? clans : [];
            const clan = clanList.find(entry => entry.status === 'approved' &&
              (Array.isArray(entry.joinRequests) ? entry.joinRequests : []).some(request => request.requestId === requestId && request.status === 'pending'));
            if (!clan) {
              await interaction.reply({ content: 'This application has already been reviewed or the clan is no longer available.', flags: MessageFlags.Ephemeral });
              return;
            }
            if (![clan.leaderId, clan.viceLeaderId].includes(interaction.user.id)) {
              await interaction.reply({ content: 'Only this clan’s Leader or Vice Clan Leader can review applications.', flags: MessageFlags.Ephemeral });
              return;
            }
            const requests = Array.isArray(clan.joinRequests) ? clan.joinRequests : [];
            const requestIndex = requests.findIndex(request => request.requestId === requestId && request.status === 'pending');
            const applicantId = requests[requestIndex].userId;
            const applicant = await guild.members.fetch(applicantId).catch(() => null);
            if (decision === 'accept') {
              if (!applicant) {
                requests[requestIndex].status = 'closed';
                requests[requestIndex].reviewedBy = interaction.user.id;
                requests[requestIndex].reviewedAt = new Date().toISOString();
                clan.joinRequests = requests;
                await interaction.client.db.set(storageKey, clanList);
                await interaction.update({ content: 'Applicant is no longer a member of this server. Application closed.', embeds: [], components: [] });
                return;
              }
              const alreadyInAnotherClan = clanList.find(entry =>
                entry.status === 'approved' &&
                entry.id !== clan.id &&
                [entry.leaderId, entry.viceLeaderId, ...(entry.memberIds || [])].includes(applicantId)
              );
              if (alreadyInAnotherClan) {
                await interaction.reply({ content: 'This member already belongs to another clan.', flags: MessageFlags.Ephemeral });
                return;
              }
              const currentMembers = Array.isArray(clan.memberIds) ? clan.memberIds : [];
              const clanCapacity = Math.max(10, Number(clan.maxMembers) || 10);
              if (currentMembers.length + 2 >= clanCapacity) {
                await interaction.reply({ content: 'This clan has reached its current capacity of ' + clanCapacity + ' members (including leadership). Purchase another Clan Member Expansion in the Clan Shop to add 10 more slots, up to 200.', flags: MessageFlags.Ephemeral });
                return;
              }
              const role = await guild.roles.fetch(clan.roleId).catch(() => null);
              if (!role) {
                await interaction.reply({ content: 'The clan role could not be found. Please contact an administrator.', flags: MessageFlags.Ephemeral });
                return;
              }
              await applicant.roles.add(role, `Accepted into clan ${clan.name}`);
              await applyHighestPriorityAutoNick(applicant).catch(error => {
                logger.warn(`Could not apply highest-priority AutoNick for ${applicantId} after joining clan: ${error.message}`);
              });
              clan.memberIds = [...new Set([...(clan.memberIds || []), applicantId])];
              requests[requestIndex].status = 'accepted';
              requests[requestIndex].reviewedBy = interaction.user.id;
              requests[requestIndex].reviewedAt = new Date().toISOString();
              clan.joinRequests = requests;
              await interaction.client.db.set(storageKey, clanList);
              await applicant.send(`✅ Your application to join **${clan.name} [${clan.tag}]** was accepted. Welcome to the clan!`).catch(() => {});
              await interaction.update({ content: `✅ Application accepted. <@${applicantId}> has been added to **${clan.name} [${clan.tag}]**.`, embeds: [], components: [] });
              return;
            }
            if (decision === 'reject') {
              requests[requestIndex].status = 'rejected';
              requests[requestIndex].reviewedBy = interaction.user.id;
              requests[requestIndex].reviewedAt = new Date().toISOString();
              clan.joinRequests = requests;
              await interaction.client.db.set(storageKey, clanList);
              if (applicant) await applicant.send(`❌ Your application to join **${clan.name} [${clan.tag}]** was declined by the clan leadership.`).catch(() => {});
              await interaction.update({ content: `❌ Application from <@${applicantId}> declined by <@${interaction.user.id}>.`, embeds: [], components: [] });
              return;
            }
          }

          if (interaction.customId.startsWith('clan:review:')) {
            const [, , decision, clanId] = interaction.customId.split(':');
            const approverRoleId = await interaction.client.db.get(
              `guild:${interaction.guildId}:clan_approval_role`,
              null
            );
            const reviewingMember = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
            if (!approverRoleId || !reviewingMember?.roles?.cache?.has(approverRoleId)) {
              await interaction.reply({
                content: 'You do not have the configured Clan Approver role.',
                flags: MessageFlags.Ephemeral,
              });
              return;
            }
            const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');
            const storageKey = `guild:${interaction.guildId}:clans`;
            const clans = await interaction.client.db.get(storageKey, []);
            const clanList = Array.isArray(clans) ? clans : [];
            const clanIndex = clanList.findIndex(entry => entry.id === clanId);
            if (clanIndex < 0 || clanList[clanIndex].status !== 'pending') {
              await interaction.reply({
                content: 'This clan application has already been reviewed or no longer exists.',
                flags: MessageFlags.Ephemeral,
              });
              return;
            }
            const reviewedClan = clanList[clanIndex];
            if (decision === 'approve') {
              let approvalStage = 'starting approval';
              try {
                await interaction.deferUpdate();

                approvalStage = 'creating or fetching the clan role';
                let clanRole = reviewedClan.roleId
                  ? await interaction.guild.roles.fetch(reviewedClan.roleId).catch(() => null)
                  : null;

                if (!clanRole) {
                  clanRole = await interaction.guild.roles.create({
                    name: reviewedClan.name,
                    colors: { primaryColor: Number.parseInt((reviewedClan.roleHex || '#5865F2').slice(1), 16) },
                    reason: `Automatic clan role for approved clan: ${reviewedClan.name}`,
                  });
                }

                // A newly-created role is already placed beneath the bot's highest role.
                // Avoid forcing it above a configured separator role, which can fail
                // when that separator is higher than the bot.
                approvalStage = 'registering the clan AutoNick role';
                const autoNickKey = `guild:${interaction.guildId}:autonick_roles`;
                const autoNickEntriesRaw = await interaction.client.db.get(autoNickKey, []);
                const autoNickEntries = Array.isArray(autoNickEntriesRaw) ? autoNickEntriesRaw : [];
                const existingAutoNick = autoNickEntries.find(entry => String(entry.roleId) === String(clanRole.id));
                const clanAutoNickEntry = {
                  ...(existingAutoNick || {}),
                  roleId: clanRole.id,
                  tag: reviewedClan.tag,
                  prefix: '',
                  format: reviewedClan.autoNickFormat || 'TAG {username}',
                  priority: Number(existingAutoNick?.priority) || 50,
                };
                const updatedAutoNickEntries = existingAutoNick
                  ? autoNickEntries.map(entry => String(entry.roleId) === String(clanRole.id) ? clanAutoNickEntry : entry)
                  : [...autoNickEntries, clanAutoNickEntry];
                await interaction.client.db.set(autoNickKey, updatedAutoNickEntries);

                reviewedClan.roleId = clanRole.id;
                reviewedClan.status = 'approved';
                reviewedClan.reviewedBy = interaction.user.id;
                reviewedClan.reviewedAt = new Date().toISOString();
                await interaction.client.db.set(storageKey, clanList);

                const assignmentErrors = [];
                for (const [memberId, label] of [
                  [reviewedClan.leaderId, 'Clan Leader'],
                  [reviewedClan.viceLeaderId, 'Vice Clan Leader'],
                ]) {
                  if (!memberId) continue;
                  approvalStage = `assigning the clan role to the ${label}`;
                  const member = await interaction.guild.members.fetch(memberId).catch(() => null);
                  if (!member) {
                    assignmentErrors.push(`${label} is no longer in the server`);
                    continue;
                  }
                  try {
                    await member.roles.add(clanRole, `Assign approved clan role to ${label.toLowerCase()}`);
                    await member.roles.fetch();
                    await applyHighestPriorityAutoNick(member).catch(error => {
                      logger.warn('Clan AutoNick could not be refreshed after role assignment.', {
                        error: error.message, guildId: interaction.guildId, clanId, memberId,
                      });
                    });
                  } catch (error) {
                    assignmentErrors.push(`${label}: ${error.message}`);
                    logger.error('Failed to assign approved clan role to a member:', {
                      error: error.message, code: error.code, guildId: interaction.guildId, clanId, memberId,
                    });
                  }
                }

                let voiceChannelWarning = null;
                const clanVoiceCategoryId = '1574641736695816334';
                try {
                  const category = await interaction.guild.channels.fetch(clanVoiceCategoryId);
                  if (!category || category.type !== ChannelType.GuildCategory) {
                    throw new Error(`Configured clan voice category ${clanVoiceCategoryId} was not found or is not a category.`);
                  }

                  let clanVoiceChannel = reviewedClan.voiceChannelId
                    ? await interaction.guild.channels.fetch(reviewedClan.voiceChannelId).catch(() => null)
                    : null;
                  if (!clanVoiceChannel) {
                    clanVoiceChannel = await interaction.guild.channels.create({
                      name: reviewedClan.name.slice(0, 100),
                      type: ChannelType.GuildVoice,
                      parent: category.id,
                      reason: `Voice channel for approved clan: ${reviewedClan.name}`,
                    });
                  }
                  reviewedClan.voiceChannelId = clanVoiceChannel.id;
                  await interaction.client.db.set(storageKey, clanList);
                } catch (voiceError) {
                  voiceChannelWarning = `The clan was approved, but I could not create its voice channel: ${voiceError.message}. Check the category and my Manage Channels permission.`;
                  logger.error('Failed to create voice channel for approved clan:', {
                    error: voiceError.message,
                    code: voiceError.code,
                    guildId: interaction.guildId,
                    clanId,
                    categoryId: clanVoiceCategoryId,
                  });
                }

                const updated = EmbedBuilder.from(interaction.message.embeds[0] || {})
                  .setColor(Number.parseInt((reviewedClan.roleHex || '#5865F2').slice(1), 16))
                  .setTitle(`🏰 ${reviewedClan.name}`)
                  .addFields(
                    { name: '📝 Status', value: `✅ Approved by <@${interaction.user.id}>`, inline: true },
                    { name: '🎭 Clan Role', value: `<@&${clanRole.id}>`, inline: true },
                  );
                await interaction.message.edit({ embeds: [updated], components: [] });

                if (assignmentErrors.length) {
                  await interaction.followUp({
                    content: `The clan was approved and the role was created, but I could not assign it to everyone: ${assignmentErrors.join('; ')}. Check my Manage Roles permission and role hierarchy.`,
                    flags: MessageFlags.Ephemeral,
                  });
                }
                if (voiceChannelWarning) {
                  await interaction.followUp({ content: voiceChannelWarning, flags: MessageFlags.Ephemeral });
                }
                return;
              } catch (error) {
                logger.error('Failed to approve clan:', {
                  stage: approvalStage,
                  error: error.message,
                  code: error.code,
                  rawError: error.rawError,
                  guildId: interaction.guildId,
                  clanId,
                });
                const message = `Clan approval failed while ${approvalStage}. Discord error: ${error.message || 'Unknown error'}. Check that I have Manage Roles permission and that my highest role is above the clan role.`;
                if (interaction.deferred || interaction.replied) {
                  await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
                } else {
                  await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
                }
                return;
              }
            }
            if (decision === 'reject') {
              const refundAmount = Number(reviewedClan.creationFeePaid) || 0;
              if (refundAmount > 0) {
                try {
                  await addMoney(
                    interaction.client,
                    interaction.guildId,
                    reviewedClan.leaderId,
                    refundAmount,
                    'wallet'
                  );
                } catch (error) {
                  logger.error('Failed to refund rejected clan creation fee:', {
                    error: error.message,
                    guildId: interaction.guildId,
                    clanId,
                    leaderId: reviewedClan.leaderId,
                    refundAmount,
                  });
                  await interaction.reply({
                    content: 'I could not refund the clan creation fee, so this application remains pending. Please resolve the economy error and try rejecting it again.',
                    flags: MessageFlags.Ephemeral,
                  });
                  return;
                }
              }

              clanList.splice(clanIndex, 1);
              await interaction.client.db.set(storageKey, clanList);
              const updated = EmbedBuilder.from(interaction.message.embeds[0] || {})
                .setColor(0xED4245)
                .addFields({
                  name: '📝 Status',
                  value: refundAmount > 0
                    ? `❌ Rejected by <@${interaction.user.id}> • 💰 ${refundAmount.toLocaleString()} bCash refunded to the clan leader`
                    : `❌ Rejected by <@${interaction.user.id}>`,
                  inline: false,
                });
              await interaction.update({ embeds: [updated], components: [] });

              const leader = await interaction.guild.members.fetch(reviewedClan.leaderId).catch(() => null);
              if (leader && refundAmount > 0) {
                await leader.send(`❌ Your clan application for **${reviewedClan.name} [${reviewedClan.tag}]** was not approved. Your **${refundAmount.toLocaleString()} bCash** clan creation fee has been refunded to your wallet.`).catch(() => {});
              }
              return;
            }
          }

          if (interaction.customId.startsWith('clan:delete:')) {
            const [, , action, ownerId] = interaction.customId.split(':');

            if (interaction.user.id !== ownerId) {
              await interaction.reply({
                content: 'Only the Clan Leader who opened this confirmation can use these buttons.',
                flags: MessageFlags.Ephemeral,
              });
              return;
            }

            if (action === 'cancel') {
              await interaction.update({
                content: 'Clan removal cancelled. Your clan is safe.',
                embeds: [],
                components: [],
              });
              return;
            }

            if (action === 'confirm') {
              const storageKey = `guild:${interaction.guildId}:clans`;
              const clans = await interaction.client.db.get(storageKey, []);
              const clanList = Array.isArray(clans) ? clans : [];
              const clanIndex = clanList.findIndex(entry => entry.leaderId === interaction.user.id);

              if (clanIndex === -1) {
                await interaction.update({
                  content: 'No clan led by you was found. It may have already been removed.',
                  embeds: [],
                  components: [],
                });
                return;
              }

              const [removedClan] = clanList.splice(clanIndex, 1);
              // Remove the deleted clan role from AutoNick so /autonick list has no stale entry.
              const autoNickKey = `guild:${interaction.guildId}:autonick_roles`;
              const autoNickEntries = await interaction.client.db.get(autoNickKey, []);
              await interaction.client.db.set(
                autoNickKey,
                (Array.isArray(autoNickEntries) ? autoNickEntries : [])
                  .filter(entry => String(entry.roleId) !== String(removedClan.roleId || '')),
              );
              // Save the registry first so the nickname resolver no longer selects this clan tag.
              await interaction.client.db.set(storageKey, clanList);

              // Remove the clan role and clan tag from every member, while restoring
              // any applicable department or highest-rank nickname prefix.
              if (removedClan.roleId) {
                const clanMemberIds = [...new Set([
                  removedClan.leaderId,
                  removedClan.viceLeaderId,
                  ...(Array.isArray(removedClan.memberIds) ? removedClan.memberIds : []),
                ].filter(Boolean))];

                const clanRole = await interaction.guild.roles.fetch(removedClan.roleId).catch(() => null);
                for (const userId of clanMemberIds) {
                  const clanMember = await interaction.guild.members.fetch(userId).catch(() => null);
                  if (!clanMember) continue;

                  if (clanRole && clanMember.roles.cache.has(clanRole.id)) {
                    await clanMember.roles.remove(
                      clanRole,
                      `Clan ${removedClan.name} [${removedClan.tag}] was removed`,
                    ).catch(error => {
                      logger.warn(`Failed to remove clan role from member ${userId}: ${error.message}`);
                    });
                  }

                  const nicknameStateKey = `guild:${interaction.guildId}:autonick_member:${userId}`;
                  const nicknameState = await interaction.client.db.get(nicknameStateKey, null);
                  const currentName = typeof nicknameState?.originalNickname === 'string'
                    ? nicknameState.originalNickname
                    : (clanMember.nickname ?? clanMember.user.globalName ?? clanMember.user.username);
                  const clanTagPrefix = `${removedClan.tag} `;
                  const restoredBaseName = currentName.startsWith(clanTagPrefix)
                    ? currentName.slice(clanTagPrefix.length).trim()
                    : currentName;
                  await interaction.client.db.set(nicknameStateKey, {
                    originalNickname: restoredBaseName,
                    savedAt: nicknameState?.savedAt || Date.now(),
                  });
                  await applyHighestPriorityAutoNick(clanMember).catch(error => {
                    logger.warn(`Failed to restore nickname for member ${userId} after clan deletion: ${error.message}`);
                  });
                }
              }

              const logChannelId = await interaction.client.db.get(
                `guild:${interaction.guildId}:clan_log_channel`,
                null
              );
              if (logChannelId) {
                try {
                  const logChannel = await interaction.guild.channels.fetch(logChannelId);
                  if (logChannel?.isTextBased() && logChannel?.send) {
                    const { EmbedBuilder } = await import('discord.js');
                    const logEmbed = new EmbedBuilder()
                      .setColor(0xED4245)
                      .setTitle('🗑️ Clan Registration Removed')
                      .setDescription(`**${removedClan.name} [${removedClan.tag}]** has been removed from the clan registry.`)
                      .addFields(
                        { name: 'Clan Leader', value: `<@${removedClan.leaderId}>`, inline: true },
                        { name: 'Removed By', value: `<@${interaction.user.id}>`, inline: true },
                      )
                      .setTimestamp()
                      .setFooter({ text: `Barracks Clan Registry • ${interaction.guild.name}` });
                    await logChannel.send({ embeds: [logEmbed] });
                  }
                } catch (error) {
                  logger.error('Failed to log clan removal:', {
                    error: error.message,
                    guildId: interaction.guildId,
                    channelId: logChannelId,
                  });
                }
              }

              await interaction.update({
                content: `✅ **${removedClan.name} [${removedClan.tag}]** has been removed from the Barracks clan registry.`,
                embeds: [],
                components: [],
              });
              return;
            }
          }

          if (interaction.customId.startsWith('shared_todo_')) {
            const parts = interaction.customId.split('_');
            const buttonType = parts.slice(0, 3).join('_');
            const listId = parts[3];
            const button = client.buttons.get(buttonType);

            if (button) {
              try {
                await button.execute(interaction, client, [listId]);
              } catch (error) {
                await handleInteractionError(interaction, error, withTraceContext({
                  type: 'button',
                  customId: interaction.customId,
                  handler: 'todo'
                }, interactionTraceContext));
              }
            } else {
              throw createError(
                `No button handler found for ${buttonType}`,
                ErrorTypes.CONFIGURATION,
                'This button is not available.',
                withTraceContext({ buttonType }, interactionTraceContext)
              );
            }
            return;
          }

          const [customId, ...args] = interaction.customId.split(':');
          const button = client.buttons.get(customId);

          if (!button) {
            if (!interaction.customId.includes(':') || isCollectorManagedComponent(customId)) {
              return;
            }

            throw createError(
              `No button handler found for ${customId}`,
              ErrorTypes.CONFIGURATION,
              'This button is not available.',
              withTraceContext({ customId }, interactionTraceContext)
            );
          }

          try {
            await button.execute(interaction, client, args);
          } catch (error) {
            await handleInteractionError(interaction, error, withTraceContext({
              type: 'button',
              customId: interaction.customId,
              handler: 'general'
            }, interactionTraceContext));
          }
        } else if (interaction.isStringSelectMenu()) {
          if (interaction.customId.startsWith('bcal:event:')) {
            const [, , guildId] = interaction.customId.split(':');
            if (!interaction.guild || interaction.guildId !== guildId) {
              await interaction.reply({ content: 'This Barracks Calendar belongs to another server.', flags: MessageFlags.Ephemeral });
              return;
            }
            const events = await getCalendarEvents(client, guildId);
            const event = events.find(entry => entry.id === interaction.values[0] && !entry.cancelled);
            if (!event) {
              await interaction.reply({ content: 'That event is no longer available. Refresh the calendar and try again.', flags: MessageFlags.Ephemeral });
              return;
            }
            await interaction.reply({ content: formatCalendarEvent(event), flags: MessageFlags.Ephemeral });
            return;
          }
          if (interaction.customId === 'clan:join:select') {
            const clanId = interaction.values[0];
            const storageKey = `guild:${interaction.guildId}:clans`;
            const clans = await interaction.client.db.get(storageKey, []);
            const clanList = Array.isArray(clans) ? clans : [];
            const clan = clanList.find(entry => entry.id === clanId && entry.status === 'approved' && entry.roleId);
            if (!clan) {
              await interaction.reply({ content: 'That clan is no longer available. Please reopen the panel.', flags: MessageFlags.Ephemeral });
              return;
            }
            if (clan.leaderId === interaction.user.id) {
              await interaction.reply({ content: 'You are the Clan Leader of this clan. Transfer leadership or delete the clan before joining another.', flags: MessageFlags.Ephemeral });
              return;
            }
            const isListedInSelectedClan = String(clan.viceLeaderId || '') === interaction.user.id ||
              (Array.isArray(clan.memberIds) && clan.memberIds.map(String).includes(interaction.user.id));
            if (isListedInSelectedClan) {
              const applicantMember = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
              const stillHasClanRole = Boolean(applicantMember && clan.roleId && applicantMember.roles.cache.has(clan.roleId));
              if (stillHasClanRole) {
                await interaction.reply({ content: 'You still have this clan role. Use **Leave a Clan** first; if you already left, ask staff to check the bot role permissions.', flags: MessageFlags.Ephemeral });
                return;
              }
              // Repair stale roster/vice-leader records left behind by an older leave flow.
              clan.memberIds = (Array.isArray(clan.memberIds) ? clan.memberIds : []).filter(id => String(id) !== interaction.user.id);
              if (String(clan.viceLeaderId || '') === interaction.user.id) clan.viceLeaderId = null;
              await interaction.client.db.set(storageKey, clanList);
            }
            const currentClan = clanList.find(entry => entry.status === 'approved' &&
              [entry.leaderId, entry.viceLeaderId, ...(entry.memberIds || [])].includes(interaction.user.id));
            if (currentClan) {
              await interaction.reply({ content: `You already belong to **${currentClan.name} [${currentClan.tag}]**. Leave that clan before applying to another.`, flags: MessageFlags.Ephemeral });
              return;
            }
            clan.joinRequests = Array.isArray(clan.joinRequests) ? clan.joinRequests : [];
            const existing = clan.joinRequests.find(request => request.userId === interaction.user.id && request.status === 'pending');
            if (existing) {
              await interaction.reply({ content: `You already have a pending application for **${clan.name} [${clan.tag}]**.`, flags: MessageFlags.Ephemeral });
              return;
            }
            const requestId = `jr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            clan.joinRequests.push({ requestId, userId: interaction.user.id, status: 'pending', appliedAt: new Date().toISOString() });
            await interaction.client.db.set(storageKey, clanList);
            const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');
            const requestEmbed = new EmbedBuilder()
              .setColor(Number.parseInt((clan.roleHex || '#5865F2').slice(1), 16))
              .setTitle('📨 Clan Membership Application')
              .setDescription(`<@${interaction.user.id}> wants to join **${clan.name} [${clan.tag}]**.`)
              .addFields(
                { name: 'Applicant', value: `<@${interaction.user.id}> (${interaction.user.id})`, inline: true },
                { name: 'Clan', value: `${clan.name} [${clan.tag}]`, inline: true },
              )
              .setTimestamp()
              .setFooter({ text: 'Barracks • Clan Registry' });
            const reviewRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`clan:join:decision:accept:${interaction.guildId}:${requestId}`).setLabel('Accept').setEmoji('✅').setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId(`clan:join:decision:reject:${interaction.guildId}:${requestId}`).setLabel('Decline').setEmoji('❌').setStyle(ButtonStyle.Danger),
            );
            const leaders = [...new Set([clan.leaderId, clan.viceLeaderId].filter(Boolean))];
            const deliveries = await Promise.all(leaders.map(async leaderId => {
              const leader = await interaction.guild.members.fetch(leaderId).catch(() => null);
              if (!leader) return false;
              return leader.send({ embeds: [requestEmbed], components: [reviewRow] }).then(() => true).catch(() => false);
            }));
            if (!deliveries.some(Boolean)) {
              clan.joinRequests = clan.joinRequests.filter(request => request.userId !== interaction.user.id);
              await interaction.client.db.set(storageKey, clanList);
              await interaction.reply({ content: 'I could not deliver the application to either clan leader. Please ask them to enable DMs and try again.', flags: MessageFlags.Ephemeral });
              return;
            }
            await interaction.reply({ content: `✅ Your application to join **${clan.name} [${clan.tag}]** has been sent to the Clan Leader and Vice Clan Leader for review.`, flags: MessageFlags.Ephemeral });
            return;
          }
          const [customId, ...args] = interaction.customId.split(':');
          const selectMenu = client.selectMenus.get(customId);

          if (!selectMenu) {
            if (!interaction.customId.includes(':') || isCollectorManagedComponent(customId)) {
              return;
            }

            throw createError(
              `No select menu handler found for ${customId}`,
              ErrorTypes.CONFIGURATION,
              'This select menu is not available.',
              withTraceContext({ customId }, interactionTraceContext)
            );
          }

          try {
            await selectMenu.execute(interaction, client, args);
          } catch (error) {
            await handleInteractionError(interaction, error, withTraceContext({
              type: 'select_menu',
              customId: interaction.customId
            }, interactionTraceContext));
          }
        } else if (interaction.isModalSubmit()) {
          if (interaction.customId.startsWith('tournament:modal:')) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const [, , action, tournamentId] = interaction.customId.split(':');
            const key = 'guild:' + interaction.guildId + ':tournaments';
            const stored = await client.db.get(key, []);
            const tournaments = Array.isArray(stored) ? stored : [];
            const tournament = tournaments.find(item => item.id === tournamentId);
            if (!tournament || !tournament.teamMode) { await interaction.editReply({ content: 'This team registration is no longer available.' }); return; }
            if (tournament.status !== 'registration' || (tournament.deadline && Date.now() > Date.parse(tournament.deadline))) { await interaction.editReply({ content: 'Team registration is closed.' }); return; }
            if (!Array.isArray(tournament.teams)) tournament.teams = [];
            if (!Array.isArray(tournament.registrations)) tournament.registrations = [];
            const registered = new Set(tournament.registrations.map(entry => entry.userId));
            const min = Number(tournament.teamMinPlayers || 1), max = Number(tournament.teamMaxPlayers || 5);
            if (action === 'teamcreate') {
              const name = interaction.fields.getTextInputValue('team_name').trim();
              if (!name || name.length > 32) { await interaction.editReply({ content: 'Enter a team name between 1 and 32 characters.' }); return; }
              if (registered.has(interaction.user.id)) { await interaction.editReply({ content: 'You are already registered in this tournament.' }); return; }
              if (tournament.teams.some(team => team.name.toLowerCase() === name.toLowerCase())) { await interaction.editReply({ content: 'That team name is already taken.' }); return; }
              if (tournament.registrations.length >= Number(tournament.limit)) { await interaction.editReply({ content: 'The tournament player limit has been reached.' }); return; }
              const team = { id: crypto.randomUUID(), name, captainId: interaction.user.id, members: [], createdAt: new Date().toISOString() };
              tournament.teams.push(team);
              tournament.registrations.push({ userId: interaction.user.id, username: interaction.user.globalName || interaction.user.username, registeredAt: new Date().toISOString(), teamId: team.id });
              await client.db.set(key, tournaments);
              await interaction.editReply({ content: 'Your team **' + name + '** has been created. Use **Invite Player** to add teammates. Team size: ' + min + '–' + max + ' players.' });
              return;
            }
            if (action === 'teaminvite') {
              const raw = interaction.fields.getTextInputValue('member_id').trim();
              const targetId = raw.match(/^(?:<@!?)?(\d{17,20})>?$/)?.[1];
              if (!targetId) { await interaction.editReply({ content: 'Enter a valid player mention or Discord user ID.' }); return; }
              const team = tournament.teams.find(entry => entry.captainId === interaction.user.id);
              if (!team) { await interaction.editReply({ content: 'Only a team captain can invite players. Create a team first.' }); return; }
              if (registered.has(targetId)) { await interaction.editReply({ content: 'That player is already registered in this tournament.' }); return; }
              if (1 + (team.members || []).length >= max) { await interaction.editReply({ content: 'Your team has reached its maximum size of ' + max + ' players.' }); return; }
              if (tournament.registrations.length >= Number(tournament.limit)) { await interaction.editReply({ content: 'The tournament player limit has been reached.' }); return; }
              const member = await interaction.guild.members.fetch(targetId).catch(() => null);
              if (!member || member.user.bot) { await interaction.editReply({ content: 'That player is not a valid member of this server.' }); return; }
              if (!Array.isArray(tournament.pendingTeamInvites)) tournament.pendingTeamInvites = [];
              if (tournament.pendingTeamInvites.some(entry => entry.userId === targetId && entry.teamId === team.id)) { await interaction.editReply({ content: 'That player already has a pending invitation.' }); return; }
              const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');
              const inviteRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('tournament:accept:' + interaction.guildId + ':' + tournament.id + ':' + team.id).setLabel('Accept Team Invitation').setStyle(ButtonStyle.Success));
              try {
                await member.send({ content: '🛡️ **' + interaction.user.username + '** invited you to join **' + team.name + '** for **' + tournament.name + '** in Barracks.', components: [inviteRow] });
              } catch {
                await interaction.editReply({ content: 'I could not DM that player. Ask them to enable server DMs, then try again.' });
                return;
              }
              tournament.pendingTeamInvites.push({ userId: targetId, teamId: team.id, invitedBy: interaction.user.id, invitedAt: new Date().toISOString() });
              await client.db.set(key, tournaments);
              await interaction.editReply({ content: 'Team invitation sent to <@' + targetId + '>. They must accept the DM invitation to join **' + team.name + '**.' });
              return;
            }
            await interaction.editReply({ content: 'Unknown team action.' });
            return;
          }
          if (interaction.customId === 'barracks_nickname_modal') {
            await handleNicknameChangeModal(interaction, client);
            return;
          }
          if (interaction.customId === 'clan:leader:addmember:submit' || interaction.customId === 'clan:leader:kickmember:submit') {
            if (!interaction.inGuild()) {
              await interaction.reply({ content: 'This action can only be used in a server.', flags: MessageFlags.Ephemeral });
              return;
            }
            const isAdd = interaction.customId === 'clan:leader:addmember:submit';
            const rawTarget = interaction.fields.getTextInputValue('member_id').trim();
            const targetId = rawTarget.match(/^(?:<@!?)?(\d{17,20})>?$/)?.[1];
            if (!targetId) {
              await interaction.reply({ content: 'Enter a valid member mention or Discord user ID.', flags: MessageFlags.Ephemeral });
              return;
            }
            const storageKey = 'guild:' + interaction.guildId + ':clans';
            const clanData = await interaction.client.db.get(storageKey, []);
            const clanList = Array.isArray(clanData) ? clanData : [];
            const clan = clanList.find(entry => entry.status === 'approved' &&
              [String(entry.leaderId || ''), String(entry.viceLeaderId || '')].includes(interaction.user.id));
            if (!clan) {
              await interaction.reply({ content: 'Only the Clan Leader or Vice Clan Leader of an approved clan can manage members.', flags: MessageFlags.Ephemeral });
              return;
            }
            if (targetId === String(clan.leaderId) || targetId === String(clan.viceLeaderId || '')) {
              await interaction.reply({ content: 'Clan leadership cannot be added or removed through regular member management.', flags: MessageFlags.Ephemeral });
              return;
            }
            const targetMember = await interaction.guild.members.fetch(targetId).catch(() => null);
            if (!targetMember || targetMember.user.bot) {
              await interaction.reply({ content: 'I could not find that human server member. Please check the mention or ID.', flags: MessageFlags.Ephemeral });
              return;
            }
            const members = Array.isArray(clan.memberIds) ? clan.memberIds.map(String) : [];
            if (isAdd) {
              const otherClan = clanList.find(entry =>
                String(entry.leaderId || '') === targetId ||
                String(entry.viceLeaderId || '') === targetId ||
                (Array.isArray(entry.memberIds) && entry.memberIds.map(String).includes(targetId))
              );
              if (otherClan) {
                await interaction.reply({ content: otherClan.id === clan.id ? 'That member is already in your clan.' : 'That member already belongs to another registered clan.', flags: MessageFlags.Ephemeral });
                return;
              }
              if (members.length + 2 >= Math.max(10, Number(clan.maxMembers) || 10)) {
                await interaction.reply({ content: 'Your clan has reached its current capacity of ' + Math.max(10, Number(clan.maxMembers) || 10) + ' members (including leadership). Purchase another Clan Member Expansion in the Clan Shop to add 10 more slots, up to 200.', flags: MessageFlags.Ephemeral });
                return;
              }
              if (clan.roleId) {
                const role = await interaction.guild.roles.fetch(clan.roleId).catch(() => null);
                if (role) await targetMember.roles.add(role, 'Added to clan ' + clan.name);
              }
              const currentName = targetMember.nickname || targetMember.user.username;
              const prefix = await getNicknamePrefix(targetMember, interaction.client, interaction.guildId);
              await targetMember.setNickname((prefix + clan.tag + ' ' + currentName).slice(0, 32), 'Added to clan ' + clan.name).catch(() => {});
              clan.memberIds = [...members, targetId];
              await interaction.client.db.set(storageKey, clanList);
              await interaction.reply({ content: '✅ <@' + targetId + '> has joined **' + clan.name + ' [' + clan.tag + ']**. Their clan role and nickname tag have been applied.', allowedMentions: { users: [targetId] }, flags: MessageFlags.Ephemeral });
              return;
            }
            if (!members.includes(targetId)) {
              await interaction.reply({ content: 'That user is not a regular member of your clan.', flags: MessageFlags.Ephemeral });
              return;
            }
            if (clan.roleId && targetMember.roles.cache.has(clan.roleId)) {
              await targetMember.roles.remove(clan.roleId, 'Removed from clan ' + clan.name);
            }
            clan.memberIds = members.filter(id => id !== targetId);
            await interaction.client.db.set(storageKey, clanList);
            const currentName = targetMember.nickname || targetMember.user.username;
            const tagPrefix = clan.tag + ' ';
            const baseName = currentName.startsWith(tagPrefix) ? currentName.slice(tagPrefix.length).trim() : currentName;
            const prefix = await getNicknamePrefix(targetMember, interaction.client, interaction.guildId);
            await targetMember.setNickname((prefix + baseName).slice(0, 32), 'Removed from clan ' + clan.name).catch(() => {});
            await interaction.reply({ content: '🗑️ <@' + targetId + '> has been removed from **' + clan.name + ' [' + clan.tag + ']**.', allowedMentions: { users: [targetId] }, flags: MessageFlags.Ephemeral });
            return;
          }
          if (interaction.customId === 'clan:create:step1') {
            const name = interaction.fields.getTextInputValue('clan_name').trim();
            const rawTagInput = interaction.fields.getTextInputValue('clan_tag').trim();
            const roleHexInput = interaction.fields.getTextInputValue('clan_role_hex').trim();
            const viceLeaderInput = interaction.fields.getTextInputValue('clan_vice_leader').trim();
            const tag = rawTagInput ? rawTagInput.normalize('NFC') : null;
            logger.info('Clan tag captured from registration modal', {
              guildId: interaction.guildId,
              userId: interaction.user.id,
              rawTagInput: JSON.stringify(rawTagInput),
              normalizedTag: JSON.stringify(tag),
              codePoints: [...rawTagInput].map((character) => `U+${character.codePointAt(0).toString(16).toUpperCase()}`),
            });
            const autoNickFormat = `TAG {username}`;
            const roleHexMatch = roleHexInput.match(/^#?([0-9a-fA-F]{6})$/);
            const roleHex = roleHexMatch ? `#${roleHexMatch[1].toUpperCase()}` : null;
            const viceLeaderId = viceLeaderInput.match(/^(?:<@!?)?(\d{17,20})>?$/)?.[1];

            const nameSegments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(name)];
            if (!name || nameSegments.length > 32 || /\p{Cc}/u.test(name)) {
              await interaction.reply({ content: 'Please enter a Clan Name using up to 32 characters. Letters, numbers, symbols, emojis, and spaces are all allowed.', flags: MessageFlags.Ephemeral });
              return;
            }
            if (!tag) {
              await interaction.reply({ content: 'Please enter a Clan Tag.', flags: MessageFlags.Ephemeral });
              return;
            }
            if (!roleHex) {
              await interaction.reply({ content: 'Role Hex must be a valid six-digit color code, such as **#5865F2**.', flags: MessageFlags.Ephemeral });
              return;
            }
            if (!viceLeaderId || viceLeaderId === interaction.user.id) {
              await interaction.reply({ content: 'Please mention a different server member as your Vice Clan Leader, or enter their user ID.', flags: MessageFlags.Ephemeral });
              return;
            }
            const viceLeader = await interaction.guild.members.fetch(viceLeaderId).catch(() => null);
            if (!viceLeader || viceLeader.user.bot) {
              await interaction.reply({ content: 'I could not find that server member. Please check the Vice Clan Leader mention or ID.', flags: MessageFlags.Ephemeral });
              return;
            }

            const storageKey = `guild:${interaction.guildId}:clans`;
            const clans = await interaction.client.db.get(storageKey, []);
            const clanList = Array.isArray(clans) ? clans : [];
            const duplicate = clanList.find(clan => String(clan.tag || '').normalize('NFC').toLocaleUpperCase() === tag.toLocaleUpperCase() || clan.name?.toLowerCase() === name.toLowerCase());
            if (duplicate) {
              await interaction.reply({ content: 'A clan with that name or tag already exists in this server. Please choose another.', flags: MessageFlags.Ephemeral });
              return;
            }
            const existingClan = clanList.find(clan => clan.leaderId === interaction.user.id);
            if (existingClan) {
              await interaction.reply({ content: `You already lead **${existingClan.name}** [${existingClan.tag}].`, flags: MessageFlags.Ephemeral });
              return;
            }

            const clanCreationFee = 3_000_000;
            const economy = await getEconomyData(interaction.client, interaction.guildId, interaction.user.id);
            const walletBalance = Number(economy?.wallet) || 0;
            if (walletBalance < clanCreationFee) {
              await interaction.reply({
                content: `Creating a clan costs **${clanCreationFee.toLocaleString()} bCash**. Your wallet has **${walletBalance.toLocaleString()} bCash**; you need **${(clanCreationFee - walletBalance).toLocaleString()} more bCash**. Your clan has not been submitted.`,
                flags: MessageFlags.Ephemeral,
              });
              return;
            }

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            await removeMoney(interaction.client, interaction.guildId, interaction.user.id, clanCreationFee, 'wallet');
            const clan = {
              id: `clan_${Date.now()}_${interaction.user.id}`,
              name,
              tag,
              description: '',
              rules: '',
              leaderId: interaction.user.id,
              viceLeaderId,
              memberIds: [],
              roleHex,
              autoNickFormat,
              status: 'pending',
              creationFeePaid: clanCreationFee,
              logoMessageId: null,
              logoChannelId: null,
              createdAt: new Date().toISOString(),
            };
            clanList.push(clan);
            await interaction.client.db.set(storageKey, clanList);

            const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');
            const logChannelId = await interaction.client.db.get(`guild:${interaction.guildId}:clan_log_channel`, null);
            if (logChannelId) {
              try {
                const logChannel = await interaction.guild.channels.fetch(logChannelId);
                if (logChannel?.isTextBased() && logChannel?.send) {
                  const logEmbed = new EmbedBuilder()
                    .setColor(Number.parseInt(roleHex.slice(1), 16))
                    .setAuthor({ name: 'BARRACKS • CLAN REGISTRY', iconURL: interaction.guild.iconURL({ size: 128 }) || undefined })
                    .setTitle(`🏰 ${name}`)
                    .setDescription('A new clan registration is awaiting review. Please check the details below.')
                    .addFields(
                      { name: '👑 CLAN LEADER', value: `<@${interaction.user.id}>\n` + '`' + `${interaction.user.id}` + '`', inline: true },
                      { name: '🛡️ VICE CLAN LEADER', value: `<@${viceLeaderId}>\n` + '`' + `${viceLeaderId}` + '`', inline: true },
                      { name: '🎨 ROLE COLOR', value: `\`${roleHex}\``, inline: true },
                      { name: '📝 STATUS', value: '⏳ Awaiting approval', inline: true },
                      { name: '📨 SUBMITTED BY', value: `<@${interaction.user.id}>`, inline: true },
                    )
                    .setTimestamp()
                    .setFooter({ text: `Barracks Clan Registry • ${interaction.guild.name}` });
                  const approverRoleId = await interaction.client.db.get(`guild:${interaction.guildId}:clan_approval_role`, null);
                  const reviewRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`clan:review:approve:${clan.id}`).setLabel('Approve Clan').setEmoji('✅').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(`clan:review:reject:${clan.id}`).setLabel('Reject Clan').setEmoji('❌').setStyle(ButtonStyle.Danger),
                  );
                  await logChannel.send({ embeds: [logEmbed], components: approverRoleId ? [reviewRow] : [], allowedMentions: { parse: [] } });
                } else {
                  logger.warn('Configured clan log channel is unavailable or not text-based.', { guildId: interaction.guildId, channelId: logChannelId });
                }
              } catch (error) {
                logger.error('Failed to send clan registration to the configured log channel:', { error: error.message, guildId: interaction.guildId, channelId: logChannelId });
              }
            } else {
              logger.warn('Clan registration submitted without a configured log channel.', { guildId: interaction.guildId });
            }

            const confirmationEmbed = new EmbedBuilder()
              .setColor(Number.parseInt(roleHex.slice(1), 16))
              .setAuthor({ name: 'BARRACKS • CLAN REGISTRY' })
              .setTitle(`⏳ ${name} — Submitted for Approval`)
              .setDescription('Your clan registration has been saved.')
              .addFields(
                { name: '👑 Clan Leader', value: `<@${interaction.user.id}>`, inline: true },
                { name: '🛡️ Vice Clan Leader', value: `<@${viceLeaderId}>`, inline: true },
                { name: '🎨 Role Color', value: '`' + roleHex + '`', inline: true },
              )
              .setFooter({ text: 'Barracks • Clan Registry' })
              .setTimestamp();
            await interaction.editReply({
              content: logChannelId
                ? 'Your clan registration was submitted and is awaiting approval!'
                : 'Your clan was saved, but no registration channel is configured. Ask an admin to run **/clan setlogchannel**.',
              embeds: [confirmationEmbed],
            });
            return;
          }

          if (interaction.customId.startsWith('app_modal_')) {
            try {
              await handleApplicationModal(interaction);
            } catch (error) {
              await handleInteractionError(interaction, error, withTraceContext({
                type: 'modal',
                customId: interaction.customId,
                handler: 'application'
              }, interactionTraceContext));
            }
            return;
          }

          if (
            interaction.customId.startsWith('app_review_')
            || interaction.customId.startsWith('jtc_')
            || interaction.customId.startsWith('config_wizard_modal:')
            || interaction.customId.startsWith('log_dash_channel_modal:')
            || interaction.customId.startsWith('log_dash_filter_modal:')
          ) {
            logger.debug(`Skipping modal handler lookup for inline-awaited modal: ${interaction.customId}`, {
              event: 'interaction.modal.inline_skipped',
              traceId: interactionTraceContext.traceId
            });
            return;
          }

          const [customId, ...args] = interaction.customId.split(':');
          const modal = client.modals.get(customId);

          if (!modal) {
            if (!interaction.customId.includes(':')) {

              return;
            }

            throw createError(
              `No modal handler found for ${customId}`,
              ErrorTypes.CONFIGURATION,
              'This form is not available.',
              withTraceContext({ customId }, interactionTraceContext)
            );
          }

          try {
            await modal.execute(interaction, client, args);
          } catch (error) {
            await handleInteractionError(interaction, error, withTraceContext({
              type: 'modal',
              customId: interaction.customId,
              handler: 'general'
            }, interactionTraceContext));
          }
        }
      } catch (error) {
        logger.error('Unhandled error in interactionCreate:', {
          event: 'interaction.unhandled_error',
          errorCode: ErrorCodes.INTERACTION_UNHANDLED,
          error,
          traceId: interactionTraceContext.traceId,
          interactionId: interaction.id,
          guildId: interaction.guildId,
          userId: interaction.user?.id
        });

        try {
          await handleInteractionError(interaction, error, withTraceContext({
            type: 'interaction',
            commandName: interaction.commandName,
            customId: interaction.customId,
            source: 'interactionCreate.unhandled'
          }, interactionTraceContext));
        } catch (replyError) {
          logger.error('Failed to send fallback error response:', {
            event: 'interaction.error_response_failed',
            errorCode: ErrorCodes.INTERACTION_RESPONSE_FAILED,
            error: replyError,
            traceId: interactionTraceContext.traceId
          });
        }
      }
    });
  }
};
