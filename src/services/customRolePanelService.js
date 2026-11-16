import {
  ActionRowBuilder,
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
} from 'discord.js';

const MAX_MENUS = 10;
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

export function buildCustomRolePanelPayload(panel) {
  const container = new ContainerBuilder().setAccentColor(0x5865F2);
  const title = String(panel.title || 'Role Selection').trim();
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${title}`));
  if (typeof panel.description === 'string' && panel.description.trim()) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(panel.description.trim()));
  }
  if (panel.menus.length) {
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  } else {
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent('*Staff can add dropdowns with `/bpanel add-menu`.*'));
  }

  for (const [index, menu] of panel.menus.entries()) {
    if (index > 0) container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    const select = new StringSelectMenuBuilder().setCustomId(`bpanel:${menu.id}`)
      .setPlaceholder(menu.placeholder || 'Choose your roles')
      .setMinValues(0).setMaxValues(menu.multiple ? menu.options.length : 1)
      .addOptions(menu.options.map(option => ({
        label: option.label, value: option.roleId,
        ...(option.description ? { description: option.description } : {}),
        ...(option.emoji ? { emoji: typeof option.emoji === 'string' ? { name: option.emoji } : option.emoji } : {})
      })));
    container.addActionRowComponents(new ActionRowBuilder().addComponents(select));
  }

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

export async function refreshCustomRolePanel(client, guild, panel) {
  const channel = await guild.channels.fetch(panel.channelId).catch(() => null);
  if (!channel?.isTextBased()) throw new Error('The panel channel is unavailable.');
  const message = await channel.messages.fetch(panel.messageId).catch(() => null);
  if (!message) throw new Error('The panel message was deleted. Create a new panel.');

  // Discord message flags are not safely convertible on an already-posted legacy embed.
  // Re-post it as a V2 message, persist the new ID, then remove the old message.
  if (!message.flags.has(MessageFlags.IsComponentsV2)) {
    const previousMessageId = panel.messageId;
    const replacementMessage = await channel.send(buildCustomRolePanelPayload(panel));
    panel.messageId = replacementMessage.id;
    await client.db.set(getCustomRolePanelKey(guild.id, replacementMessage.id), panel);
    await client.db.delete(getCustomRolePanelKey(guild.id, previousMessageId));
    await message.delete().catch(() => {});
    return replacementMessage;
  }

  await message.edit(buildCustomRolePanelPayload(panel));
  await client.db.set(getCustomRolePanelKey(guild.id, panel.messageId), panel);
  return message;
}

export const CUSTOM_ROLE_PANEL_LIMITS = { menus: MAX_MENUS, options: MAX_OPTIONS };
