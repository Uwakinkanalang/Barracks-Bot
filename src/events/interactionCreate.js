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
          if (interaction.customId === 'clan:create') {
            const { ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle, LabelBuilder, FileUploadBuilder } = await import('discord.js');
            const modal = new ModalBuilder()
              .setCustomId('clan:create:submit')
              .setTitle('Create Your Clan')
              .addLabelComponents(
                new LabelBuilder()
                  .setLabel('Clan Name')
                  .setTextInputComponent(
                    new TextInputBuilder().setCustomId('clan_name').setStyle(TextInputStyle.Short).setMinLength(3).setMaxLength(32).setRequired(true)
                  ),
                new LabelBuilder()
                  .setLabel('Clan Tag | Role Hex')
                  .setDescription('Example: A | #5865F2 (tag: 1–6 letters/numbers)')
                  .setTextInputComponent(
                    new TextInputBuilder().setCustomId('clan_tag_hex').setStyle(TextInputStyle.Short).setPlaceholder('A | #5865F2').setMaxLength(16).setRequired(true)
                  ),
                new LabelBuilder()
                  .setLabel('Clan Description')
                  .setTextInputComponent(
                    new TextInputBuilder().setCustomId('clan_description').setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(true)
                  ),
                new LabelBuilder()
                  .setLabel('Vice Clan Leader')
                  .setDescription('Enter the Vice Clan Leader’s Discord user ID (Copy User ID from their profile).')
                  .setTextInputComponent(
                    new TextInputBuilder().setCustomId('clan_vice_leader').setStyle(TextInputStyle.Short).setMaxLength(25).setRequired(true)
                  ),
                new LabelBuilder()
                  .setLabel('Clan Logo Upload (optional)')
                  .setDescription('Upload one image file, or leave it empty.')
                  .setFileUploadComponent(
                    new FileUploadBuilder()
                      .setCustomId('clan_logo')
                      .setMinValues(0)
                      .setMaxValues(1)
                      .setRequired(false)
                  )
              );
            await interaction.showModal(modal);
            return;
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
          if (interaction.customId === 'clan:create:submit') {
            const name = interaction.fields.getTextInputValue('clan_name').trim();
            const tagHexInput = interaction.fields.getTextInputValue('clan_tag_hex').trim();
                        const tagHexMatch = tagHexInput.match(/^([A-Za-z0-9]{1,6})\s*\|\s*#?([0-9a-fA-F]{6})$/);
            const tag = tagHexMatch?.[1]?.toUpperCase();
            const roleHex = tagHexMatch ? `#${tagHexMatch[2].toUpperCase()}` : null;
            const description = interaction.fields.getTextInputValue('clan_description').trim();
            const viceLeaderInput = interaction.fields.getTextInputValue('clan_vice_leader').trim();
            const viceLeaderId = viceLeaderInput.match(/^(?:<@!?)?(\d{17,20})>?$/)?.[1];

            if (!/^[a-zA-Z0-9 _-]{3,32}$/.test(name)) {
              await interaction.reply({ content: 'Clan name must be 3–32 characters and use only letters, numbers, spaces, _ or -.', flags: MessageFlags.Ephemeral });
              return;
            }
            if (!tagHexMatch || !tag || !roleHex) {
              await interaction.reply({ content: 'Enter the clan tag and role hex together in this format: **A | #5865F2**. The tag can be 1–6 letters or numbers; the hex must be 6 digits.', flags: MessageFlags.Ephemeral });
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

            const uploadedFiles = interaction.fields.getUploadedFiles('clan_logo');
            const logoAttachment = uploadedFiles?.first?.() || null;
            if (logoAttachment) {
              const allowedExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif'];
              const extension = logoAttachment.name?.slice(logoAttachment.name.lastIndexOf('.')).toLowerCase();
              if (!logoAttachment.contentType?.startsWith('image/') || !allowedExtensions.includes(extension)) {
                await interaction.reply({ content: 'The clan logo must be an image file (PNG, JPG, GIF, WEBP, or AVIF).', flags: MessageFlags.Ephemeral });
                return;
              }
            }

            const storageKey = `guild:${interaction.guildId}:clans`;
            const clans = await interaction.client.db.get(storageKey, []);
            const clanList = Array.isArray(clans) ? clans : [];
            const duplicate = clanList.find(clan =>
              clan.tag?.toUpperCase() === tag || clan.name?.toLowerCase() === name.toLowerCase()
            );
            if (duplicate) {
              await interaction.reply({ content: 'A clan with that name or tag already exists in this server. Please choose another.', flags: MessageFlags.Ephemeral });
              return;
            }
            const existingClan = clanList.find(clan => clan.leaderId === interaction.user.id);
            if (existingClan) {
              await interaction.reply({ content: `You already lead **${existingClan.name}** [${existingClan.tag}].`, flags: MessageFlags.Ephemeral });
              return;
            }

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            let logoMessage = null;
            if (logoAttachment) {
              try {
                const { EmbedBuilder } = await import('discord.js');
                const logoEmbed = new EmbedBuilder()
                  .setColor(Number.parseInt(roleHex.slice(1), 16))
                  .setTitle(`Clan Logo • ${name} [${tag}]`)
                  .setDescription(`Uploaded by <@${interaction.user.id}>`)
                  .setImage(`attachment://${logoAttachment.name}`)
                  .setFooter({ text: 'Barracks • Clan Logo Archive' });
                logoMessage = await interaction.channel.send({
                  embeds: [logoEmbed],
                  files: [{ attachment: logoAttachment.url, name: logoAttachment.name }],
                });
              } catch (error) {
                logger.error('Failed to archive uploaded clan logo:', error);
                await interaction.editReply('I could not save the uploaded logo in this channel. Please check that I have permission to send messages and attach files, then try again.');
                return;
              }
            }

            const clan = {
              id: `clan_${Date.now()}_${interaction.user.id}`,
              name,
              tag,
              description,
              leaderId: interaction.user.id,
              viceLeaderId,
              roleHex,
              logoMessageId: logoMessage?.id || null,
              logoChannelId: logoMessage?.channelId || null,
              createdAt: new Date().toISOString(),
            };
            clanList.push(clan);
            await interaction.client.db.set(storageKey, clanList);

            const { EmbedBuilder } = await import('discord.js');
            const logChannelId = await interaction.client.db.get(
              `guild:${interaction.guildId}:clan_log_channel`,
              null
            );
            if (logChannelId) {
              try {
                const logChannel = await interaction.guild.channels.fetch(logChannelId);
                if (logChannel?.isTextBased() && logChannel?.send) {
                  const logEmbed = new EmbedBuilder()
                    .setColor(Number.parseInt(roleHex.slice(1), 16))
                    .setTitle(`📋 New Clan Registration • ${name} [${tag}]`)
                    .setDescription(description)
                    .addFields(
                      { name: 'Clan Leader', value: `<@${interaction.user.id}> (\`${interaction.user.id}\`)`, inline: true },
                      { name: 'Vice Clan Leader', value: `<@${viceLeaderId}> (\`${viceLeaderId}\`)`, inline: true },
                      { name: 'Clan Tag', value: tag, inline: true },
                      { name: 'Clan Role Hex', value: roleHex, inline: true },
                      { name: 'Submitted By', value: `<@${interaction.user.id}>`, inline: true }
                    )
                    .setTimestamp()
                    .setFooter({ text: `Barracks Clan Registry • ${interaction.guild.name}` });
                  const archivedLogo = logoMessage?.attachments?.first();
                  const logPayload = { embeds: [logEmbed] };
                  if (archivedLogo) {
                    logEmbed.setImage(`attachment://${archivedLogo.name}`);
                    logPayload.files = [{ attachment: archivedLogo.url, name: archivedLogo.name }];
                  }
                  await logChannel.send(logPayload);
                }
              } catch (error) {
                logger.error('Failed to send clan registration to the configured log channel:', {
                  error: error.message,
                  guildId: interaction.guildId,
                  channelId: logChannelId,
                });
              }
            }

            const embed = new EmbedBuilder()
              .setColor(Number.parseInt(roleHex.slice(1), 16))
              .setTitle(`${name} [${tag}] • Clan Created!`)
              .setDescription(description)
              .addFields(
                { name: 'Clan Leader', value: `<@${interaction.user.id}>`, inline: true },
                { name: 'Vice Clan Leader', value: `<@${viceLeaderId}>`, inline: true },
                { name: 'Clan Role Hex', value: roleHex, inline: true }
              )
              .setFooter({ text: 'Barracks • Clan Registry' });
            if (logoMessage?.attachments?.first()) {
              embed.setThumbnail(logoMessage.attachments.first().url);
            }
            await interaction.editReply({ content: 'Your clan has been registered successfully!', embeds: [embed] });
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
