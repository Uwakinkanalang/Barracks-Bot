import { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';
import { getColor } from '../config/bot.js';

const MAX_MENUS = 5;
const MAX_OPTIONS = 25;
const DANGEROUS = ['Administrator','ManageGuild','ManageRoles','ManageChannels','ManageWebhooks','BanMembers','KickMembers','MentionEveryone'];
export const getCustomRolePanelKey = (guildId, messageId) => `guild:${guildId}:bpanels:${messageId}`;

export function validateRoleForPanel(role, guild) {
  if (!role || role.id === guild.id || role.managed) return 'This role cannot be assigned.';
  if (DANGEROUS.some(permission => role.permissions.has(permission))) return 'Roles with administrative or moderation permissions cannot be self-assigned.';
  const botHighest = guild.members.me?.roles?.highest;
  if (!botHighest || role.position >= botHighest.position) return 'The role must be below the bot highest role.';
  return null;
}

export function buildCustomRolePanelPayload(panel, guild) {
  const embed = new EmbedBuilder().setColor(getColor('info')).setTitle(panel.title).setDescription(panel.description || null)
    .setFooter({ text: 'Choose an option below to manage your roles.' });
  const components = panel.menus.map(menu => {
    const select = new StringSelectMenuBuilder().setCustomId(`bpanel:${menu.id}`)
      .setPlaceholder(menu.placeholder || 'Choose your roles')
      .setMinValues(0).setMaxValues(menu.options.length)
      .addOptions(menu.options.map(option => ({
        label: option.label, value: option.roleId,
        ...(option.description ? { description: option.description } : {}),
        ...(option.emoji ? { emoji: option.emoji } : {})
      })));
    return new ActionRowBuilder().addComponents(select);
  });
  if (panel.menus.length) {
    embed.addFields({ name: 'Available Role Menus', value: panel.menus.map((m,i) => `**${i+1}.** ${m.placeholder || 'Role selection'} — ${m.options.length} options`).join('\n') });
  }
  return { embeds: [embed], components };
}

export async function refreshCustomRolePanel(client, guild, panel) {
  const channel = await guild.channels.fetch(panel.channelId).catch(() => null);
  if (!channel?.isTextBased()) throw new Error('The panel channel is unavailable.');
  const message = await channel.messages.fetch(panel.messageId).catch(() => null);
  if (!message) throw new Error('The panel message was deleted. Create a new panel.');
  await message.edit(buildCustomRolePanelPayload(panel, guild));
  await client.db.set(getCustomRolePanelKey(guild.id, panel.messageId), panel);
  return message;
}

export const CUSTOM_ROLE_PANEL_LIMITS = { menus: MAX_MENUS, options: MAX_OPTIONS };
