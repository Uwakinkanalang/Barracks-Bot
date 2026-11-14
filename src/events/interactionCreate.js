import { Events, MessageFlags } from 'discord.js';
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
import { getNicknamePrefix } from '../commands/Economy/nickname.js';

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
              if (!(await isCommandEnabled(client, interaction.guild.id, accessKey, command.category))) {
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
          if (interaction.customId === 'clan:join:open') {
            const { ActionRowBuilder, StringSelectMenuBuilder } = await import('discord.js');
            const clans = await interaction.client.db.get(`guild:${interaction.guildId}:clans`, []);
            const approved = (Array.isArray(clans) ? clans : []).filter(clan => clan.status === 'approved' && clan.roleId);
            if (!approved.length) {
              await interaction.reply({ content: 'There are currently no approved clans available to join.', flags: MessageFlags.Ephemeral });
              return;
            }
            const options = approved.slice(0, 25).map(clan => ({
              label: clan.name.slice(0, 100),
              description: `Tag: ${clan.tag} • Leader: ${interaction.guild.members.cache.get(clan.leaderId)?.displayName || 'Clan Leader'}`.slice(0, 100),
              value: clan.id,
              emoji: '🏰',
            }));
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

          if (interaction.customId === 'clan:create') {
            const { ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle } = await import('discord.js');
            const modal = new ModalBuilder()
              .setCustomId('clan:create:step1')
              .setTitle('Create Clan • Step 1 of 2')
              .addLabelComponents(
                new LabelBuilder()
                  .setLabel('Clan Name (Emoji/Symbol First)')
                  .setDescription('Example: ⚔️ Barracks')
                  .setTextInputComponent(new TextInputBuilder().setCustomId('clan_name').setStyle(TextInputStyle.Short).setMaxLength(32).setRequired(true)),
                new LabelBuilder()
                  .setLabel('Clan Tag')
                  .setDescription('1–6 characters; letters, numbers, symbols, or emoji. No spaces.')
                  .setTextInputComponent(new TextInputBuilder().setCustomId('clan_tag').setStyle(TextInputStyle.Short).setPlaceholder('★').setMaxLength(12).setRequired(true)),
                new LabelBuilder()
                  .setLabel('Role Hex')
                  .setDescription('Six-digit color code, for example #5865F2.')
                  .setTextInputComponent(new TextInputBuilder().setCustomId('clan_role_hex').setStyle(TextInputStyle.Short).setPlaceholder('#5865F2').setMaxLength(7).setRequired(true)),
                new LabelBuilder()
                  .setLabel('Clan Description')
                  .setTextInputComponent(new TextInputBuilder().setCustomId('clan_description').setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(true)),
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
              const role = await guild.roles.fetch(clan.roleId).catch(() => null);
              if (!role) {
                await interaction.reply({ content: 'The clan role could not be found. Please contact an administrator.', flags: MessageFlags.Ephemeral });
                return;
              }
              await applicant.roles.add(role, `Accepted into clan ${clan.name}`);
              const baseName = applicant.displayName.replace(/^\\S{1,6}\\s+/, '').trim() || applicant.user.username;
              await applicant.setNickname(`${clan.tag} ${baseName}`.slice(0, 32), `Joined clan ${clan.name}`).catch(error => {
                logger.warn(`Could not update clan nickname for ${applicantId}: ${error.message}`);
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
              try {
                let clanRole = reviewedClan.roleId
                  ? await interaction.guild.roles.fetch(reviewedClan.roleId).catch(() => null)
                  : null;

                if (!clanRole) {
                  clanRole = await interaction.guild.roles.create({
                    name: reviewedClan.name,
                    color: reviewedClan.roleHex || '#5865F2',
                    reason: `Automatic clan role for approved clan: ${reviewedClan.name}`,
                  });
                }

                reviewedClan.roleId = clanRole.id;
                reviewedClan.status = 'approved';
                reviewedClan.reviewedBy = interaction.user.id;
                reviewedClan.reviewedAt = new Date().toISOString();

                const leader = await interaction.guild.members.fetch(reviewedClan.leaderId).catch(() => null);
                const viceLeader = await interaction.guild.members.fetch(reviewedClan.viceLeaderId).catch(() => null);
                if (leader) await leader.roles.add(clanRole, 'Assign approved clan role to clan leader');
                if (viceLeader) await viceLeader.roles.add(clanRole, 'Assign approved clan role to vice clan leader');

                await interaction.client.db.set(storageKey, clanList);
                const updated = EmbedBuilder.from(interaction.message.embeds[0] || {})
                  .setColor(Number.parseInt((reviewedClan.roleHex || '#5865F2').slice(1), 16))
                  .setTitle(`🏰 ${reviewedClan.name} [${reviewedClan.tag}]`)
                  .addFields(
                    { name: '📝 Status', value: `✅ Approved by <@${interaction.user.id}>`, inline: true },
                    { name: '🎭 Clan Role', value: `<@&${clanRole.id}>`, inline: true },
                  );
                await interaction.update({ embeds: [updated], components: [] });
                return;
              } catch (error) {
                logger.error('Failed to create or assign approved clan role:', {
                  error: error.message,
                  guildId: interaction.guildId,
                  clanId,
                });
                await interaction.reply({
                  content: 'I could not create or assign the clan role. Please check that I have Manage Roles permission and that my highest role is above the clan roles.',
                  flags: MessageFlags.Ephemeral,
                });
                return;
              }
            }
            if (decision === 'reject') {
              clanList.splice(clanIndex, 1);
              await interaction.client.db.set(storageKey, clanList);
              const updated = EmbedBuilder.from(interaction.message.embeds[0] || {})
                .setColor(0xED4245)
                .addFields({ name: '📝 Status', value: `❌ Rejected by <@${interaction.user.id}>`, inline: true });
              await interaction.update({ embeds: [updated], components: [] });
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

                  const currentName = clanMember.nickname || clanMember.user.username;
                  const clanTagPrefix = `${removedClan.tag} `;
                  const baseName = currentName.startsWith(clanTagPrefix)
                    ? currentName.slice(clanTagPrefix.length).trim()
                    : currentName;
                  const prefix = await getNicknamePrefix(clanMember, interaction.client, interaction.guildId);
                  await clanMember.setNickname(`${prefix}${baseName}`.slice(0, 32), 'Clan removed; clear clan nickname tag').catch(error => {
                    logger.warn(`Failed to clear clan nickname for member ${userId}: ${error.message}`);
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
            if (clan.leaderId === interaction.user.id || clan.viceLeaderId === interaction.user.id || (clan.memberIds || []).includes(interaction.user.id)) {
              await interaction.reply({ content: 'You already belong to this clan’s leadership or roster.', flags: MessageFlags.Ephemeral });
              return;
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
          if (interaction.customId === 'clan:create:step1') {
            const name = interaction.fields.getTextInputValue('clan_name').trim();
            const rawTagInput = interaction.fields.getTextInputValue('clan_tag').trim();
            const roleHexInput = interaction.fields.getTextInputValue('clan_role_hex').trim();
            const description = interaction.fields.getTextInputValue('clan_description').trim();
            const viceLeaderInput = interaction.fields.getTextInputValue('clan_vice_leader').trim();
            const tagLength = Array.from(rawTagInput).length;
            const validTag = tagLength >= 1 && tagLength <= 6 && /^[\p{L}\p{N}\p{S}\p{P}\p{M}]+$/u.test(rawTagInput);
            const tag = validTag ? rawTagInput.toUpperCase() : null;
            const roleHexMatch = roleHexInput.match(/^#?([0-9a-fA-F]{6})$/);
            const roleHex = roleHexMatch ? `#${roleHexMatch[1].toUpperCase()}` : null;
            const viceLeaderId = viceLeaderInput.match(/^(?:<@!?)?(\d{17,20})>?$/)?.[1];

            const nameSegments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(name)];
            const leadingMark = nameSegments[0]?.segment || '';
            const clanNameText = nameSegments.slice(1).map(segment => segment.segment).join('').trim();
            const startsWithEmojiOrSymbol = /^[\p{Extended_Pictographic}\p{S}\p{P}]/u.test(leadingMark);
            if (!startsWithEmojiOrSymbol || !/^[a-zA-Z0-9 _-]{0,31}$/.test(clanNameText) || name.length > 32) {
              await interaction.reply({ content: 'Clan name must start with an emoji or symbol and may be followed by letters, numbers, spaces, _ or -. Example: **⚔️ Barracks**.', flags: MessageFlags.Ephemeral });
              return;
            }
            if (!validTag || !tag) {
              await interaction.reply({ content: 'Clan Tag must be 1–6 characters with no spaces. Letters, numbers, symbols, and emoji are allowed.', flags: MessageFlags.Ephemeral });
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
            const duplicate = clanList.find(clan => clan.tag?.toUpperCase() === tag || clan.name?.toLowerCase() === name.toLowerCase());
            if (duplicate) {
              await interaction.reply({ content: 'A clan with that name or tag already exists in this server. Please choose another.', flags: MessageFlags.Ephemeral });
              return;
            }
            const existingClan = clanList.find(clan => clan.leaderId === interaction.user.id);
            if (existingClan) {
              await interaction.reply({ content: `You already lead **${existingClan.name}** [${existingClan.tag}].`, flags: MessageFlags.Ephemeral });
              return;
            }
            await interaction.client.db.set(`guild:${interaction.guildId}:clan_create_draft:${interaction.user.id}`, {
              name, tag, roleHex, description, viceLeaderId, createdAt: Date.now()
            });
            const { ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle, FileUploadBuilder } = await import('discord.js');
            const secondModal = new ModalBuilder()
              .setCustomId('clan:create:step2')
              .setTitle('Create Clan • Step 2 of 2')
              .addLabelComponents(
                new LabelBuilder()
                  .setLabel('Clan Rules')
                  .setDescription('Write the rules members must follow (up to 1000 characters).')
                  .setTextInputComponent(new TextInputBuilder().setCustomId('clan_rules').setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(true)),
                new LabelBuilder()
                  .setLabel('Clan Logo')
                  .setDescription('Upload your clan logo image (PNG, JPG, GIF, WEBP, or AVIF).')
                  .setFileUploadComponent(new FileUploadBuilder().setCustomId('clan_logo').setMinValues(1).setMaxValues(1).setRequired(true))
              );
            await interaction.showModal(secondModal);
            return;
          }

          if (interaction.customId === 'clan:create:step2') {
            const draftKey = `guild:${interaction.guildId}:clan_create_draft:${interaction.user.id}`;
            const draft = await interaction.client.db.get(draftKey, null);
            if (!draft || Date.now() - draft.createdAt > 30 * 60 * 1000) {
              await interaction.client.db.delete(draftKey).catch(() => {});
              await interaction.reply({ content: 'Your clan creation session expired. Please open the Create a Clan panel again.', flags: MessageFlags.Ephemeral });
              return;
            }
            const { name, tag, roleHex, description, viceLeaderId } = draft;
            const clanRules = interaction.fields.getTextInputValue('clan_rules').trim();
            if (!clanRules) {
              await interaction.reply({ content: 'Please enter your Clan Rules.', flags: MessageFlags.Ephemeral });
              return;
            }
            const uploadedFiles = interaction.fields.getUploadedFiles('clan_logo');
            const logoAttachment = uploadedFiles?.first?.() || null;
            if (!logoAttachment) {
              await interaction.reply({ content: 'Please upload your clan logo before submitting the registration.', flags: MessageFlags.Ephemeral });
              return;
            }
            const allowedExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif'];
            const extension = logoAttachment.name?.slice(logoAttachment.name.lastIndexOf('.')).toLowerCase();
            if (!logoAttachment.contentType?.startsWith('image/') || !allowedExtensions.includes(extension)) {
              await interaction.reply({ content: 'The clan logo must be an image file (PNG, JPG, GIF, WEBP, or AVIF).', flags: MessageFlags.Ephemeral });
              return;
            }

            const storageKey = `guild:${interaction.guildId}:clans`;
            const clans = await interaction.client.db.get(storageKey, []);
            const clanList = Array.isArray(clans) ? clans : [];
            const duplicate = clanList.find(clan => clan.tag?.toUpperCase() === tag || clan.name?.toLowerCase() === name.toLowerCase());
            if (duplicate) {
              await interaction.client.db.delete(draftKey).catch(() => {});
              await interaction.reply({ content: 'A clan with that name or tag already exists in this server. Please choose another.', flags: MessageFlags.Ephemeral });
              return;
            }
            const existingClan = clanList.find(clan => clan.leaderId === interaction.user.id);
            if (existingClan) {
              await interaction.client.db.delete(draftKey).catch(() => {});
              await interaction.reply({ content: `You already lead **${existingClan.name}** [${existingClan.tag}].`, flags: MessageFlags.Ephemeral });
              return;
            }

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const clan = {
              id: `clan_${Date.now()}_${interaction.user.id}`,
              name,
              tag,
              description,
              rules: clanRules,
              leaderId: interaction.user.id,
              viceLeaderId,
              memberIds: [],
              roleHex,
              status: 'pending',
              logoMessageId: null,
              logoChannelId: null,
              createdAt: new Date().toISOString(),
            };
            clanList.push(clan);
            await interaction.client.db.set(storageKey, clanList);
            await interaction.client.db.delete(draftKey).catch(() => {});

            const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');
            const logChannelId = await interaction.client.db.get(`guild:${interaction.guildId}:clan_log_channel`, null);
            if (logChannelId) {
              try {
                const logChannel = await interaction.guild.channels.fetch(logChannelId);
                if (logChannel?.isTextBased() && logChannel?.send) {
                  const logEmbed = new EmbedBuilder()
                    .setColor(Number.parseInt(roleHex.slice(1), 16))
                    .setAuthor({ name: 'BARRACKS • CLAN REGISTRY', iconURL: interaction.guild.iconURL({ size: 128 }) || undefined })
                    .setTitle(`🏰 ${name} [${tag}]`)
                    .setDescription(`**CLAN DESCRIPTION**\n${description}\n\n**CLAN RULES**\n${clanRules}`)
                    .addFields(
                      { name: '👑 Clan Leader', value: `<@${interaction.user.id}>\n` + '`' + `${interaction.user.id}` + '`', inline: true },
                      { name: '🛡️ Vice Clan Leader', value: `<@${viceLeaderId}>\n` + '`' + `${viceLeaderId}` + '`', inline: true },
                      { name: '🏷️ Clan Tag', value: `\`${tag}\``, inline: true },
                      { name: '🎨 Role Color', value: `\`${roleHex}\``, inline: true },
                      { name: '📝 Status', value: '⏳ Awaiting approval', inline: true },
                      { name: '📨 Submitted By', value: `<@${interaction.user.id}>`, inline: true },
                    )
                    .setTimestamp()
                    .setFooter({ text: `Barracks Clan Registry • ${interaction.guild.name}` });
                  const approverRoleId = await interaction.client.db.get(`guild:${interaction.guildId}:clan_approval_role`, null);
                  const reviewRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`clan:review:approve:${clan.id}`).setLabel('Approve Clan').setEmoji('✅').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(`clan:review:reject:${clan.id}`).setLabel('Reject Clan').setEmoji('❌').setStyle(ButtonStyle.Danger),
                  );
                  const logPayload = { embeds: [logEmbed], components: approverRoleId ? [reviewRow] : [] };
                  logEmbed.setImage(`attachment://${logoAttachment.name}`);
                  logPayload.files = [{ attachment: logoAttachment.url, name: logoAttachment.name }];
                  await logChannel.send(logPayload);
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
              .setTitle(`⏳ ${name} [${tag}] Submitted for Approval`)
              .setDescription(`Your clan registration has been saved.\n\n**Clan Description**\n${description}\n\n**Clan Rules**\n${clanRules}`)
              .addFields(
                { name: '👑 Clan Leader', value: `<@${interaction.user.id}>`, inline: true },
                { name: '🛡️ Vice Clan Leader', value: `<@${viceLeaderId}>`, inline: true },
                { name: '🏷️ Clan Tag', value: `\`${tag}\``, inline: true },
                { name: '🎨 Role Color', value: `\`${roleHex}\``, inline: true },
              )
              .setFooter({ text: 'Barracks • Clan Registry' })
              .setTimestamp()
              .setThumbnail(logoAttachment.url);
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
