import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } from 'discord.js';
import { buildCustomRolePanelPayload } from '../../services/customRolePanelService.js';
import { getCustomRolePanelKey, validateRoleForPanel, refreshCustomRolePanel, CUSTOM_ROLE_PANEL_LIMITS } from '../../services/customRolePanelService.js';

function parseEmoji(raw, lineNumber) {
  const value = String(raw || '').trim();
  if (!value) return '';
  const custom = value.match(/^<(?:(a):)?(\w{2,32}):(\d{17,20})>$/);
  if (custom) return { id: custom[3], name: custom[2], ...(custom[1] ? { animated: true } : {}) };
  if (/^\d{17,20}$/.test(value)) return { id: value };
  if (/^<a?:/.test(value) || value.includes(':')) throw new Error('Line ' + lineNumber + ': use <:emoji_name:123456789012345678>, or a Unicode emoji.');
  return { name: value };
}

function parseOptions(raw) {
  return String(raw || '').split('\n').map(line => line.trim()).filter(Boolean).map((line,index) => {
    let [label, roleId, description = '', emoji = ''] = line.split('|').map(value => value.trim());

    // Also accept a custom emoji written at the start of the label, e.g.
    // <:mobilelegends:123456789012345678>: Mobile Legends
    const inlineEmoji = label.match(/^(<(?:(?:a):)?[\\w]{2,32}:\\d{17,20}>):?\\s*(.+)$/);
    if (inlineEmoji) {
      if (!emoji) emoji = inlineEmoji[1];
      label = inlineEmoji[2].trim();
    }

    if (!label || !/^\\d{17,19}$/.test(roleId || '')) throw new Error(`Line ${index+1}: use Label|Role ID|Description|Emoji.`);
    if (label.length > 100 || description.length > 100) throw new Error(`Line ${index+1}: label and description must be 100 characters or fewer.`);
    return { label, roleId, description, emoji: parseEmoji(emoji, index + 1) };
  });
}

export default {
  data: new SlashCommandBuilder().setName('bpanel').setDescription('Create and manage customizable role dropdown panels')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand(s => s.setName('create').setDescription('Create a new role panel')
      .addChannelOption(o => o.setName('channel').setDescription('Where to post the panel').addChannelTypes(ChannelType.GuildText,ChannelType.GuildAnnouncement).setRequired(true))
      .addStringOption(o => o.setName('title').setDescription('Panel title').setMaxLength(256).setRequired(true))
      .addStringOption(o => o.setName('description').setDescription('Panel description').setMaxLength(4000).setRequired(false)))
    .addSubcommand(s => s.setName('add-menu').setDescription('Add a dropdown menu to an existing panel')
      .addStringOption(o => o.setName('message-id').setDescription('Panel message ID').setRequired(true))
      .addStringOption(o => o.setName('placeholder').setDescription('Text shown before a selection').setMaxLength(150).setRequired(true))
      .addStringOption(o => o.setName('options').setDescription('One per line: Label|Role ID|Description|Emoji').setMaxLength(4000).setRequired(true))
      .addBooleanOption(o => o.setName('multiple').setDescription('Allow members to select more than one role').setRequired(false)))
    .addSubcommand(s => s.setName('delete').setDescription('Delete a role panel')
      .addStringOption(o => o.setName('message-id').setDescription('Panel message ID').setRequired(true)))
    .addSubcommand(s => s.setName('list').setDescription('List role panels in this server')),
  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const db = interaction.client.db;
    if (sub === 'create') {
      const channel = interaction.options.getChannel('channel');
      const me = interaction.guild.members.me ?? await interaction.guild.members.fetchMe();
      if (!me.permissions.has(PermissionFlagsBits.ManageRoles) || !channel.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)) {
        return interaction.reply({ content: 'I need Manage Roles and permission to send messages in that channel.', flags: MessageFlags.Ephemeral });
      }
      const panel = { guildId: interaction.guildId, channelId: channel.id, messageId: null, title: interaction.options.getString('title'), description: interaction.options.getString('description') || '', menus: [], createdAt: new Date().toISOString() };
      const message = await channel.send(buildCustomRolePanelPayload(panel));
      panel.messageId = message.id;
      try { await db.set(getCustomRolePanelKey(interaction.guildId,message.id), panel); }
      catch (error) { await message.delete().catch(()=>{}); throw error; }
      return interaction.reply({ content: `✅ Panel created: ${message.url}\nAdd dropdowns with ` + '`/bpanel add-menu`' + `. You can add up to ${CUSTOM_ROLE_PANEL_LIMITS.menus} menus.`, flags: MessageFlags.Ephemeral });
    }
    if (sub === 'add-menu') {
      const messageId = interaction.options.getString('message-id');
      const key = getCustomRolePanelKey(interaction.guildId,messageId);
      const panel = await db.get(key);
      if (!panel) return interaction.reply({ content: 'I could not find a Barracks role panel with that message ID.', flags: MessageFlags.Ephemeral });
      if (panel.menus.length >= CUSTOM_ROLE_PANEL_LIMITS.menus) return interaction.reply({ content: 'This panel already has the maximum of ${CUSTOM_ROLE_PANEL_LIMITS.menus} dropdown menus.', flags: MessageFlags.Ephemeral });
      const options = parseOptions(interaction.options.getString('options'));
      if (!options.length || options.length > CUSTOM_ROLE_PANEL_LIMITS.options) return interaction.reply({ content: 'Add between 1 and 25 options, one per line.', flags: MessageFlags.Ephemeral });
      const seen = new Set();
      for (const option of options) {
        if (seen.has(option.roleId)) throw new Error('A role can only appear once in the same dropdown.');
        seen.add(option.roleId);
        const role = await interaction.guild.roles.fetch(option.roleId).catch(()=>null);
        const reason = validateRoleForPanel(role,interaction.guild);
        if (reason) throw new Error(`<@&${option.roleId}>: ${reason}`);
      }
      const menu = { id: `m${Date.now().toString(36)}`, placeholder: interaction.options.getString('placeholder'), multiple: interaction.options.getBoolean('multiple') ?? true, options };
      panel.menus.push(menu);
      const message = await refreshCustomRolePanel(interaction.client,interaction.guild,panel);
      return interaction.reply({ content: `✅ Dropdown added to ${message.url}. This panel now has ${panel.menus.length}/${CUSTOM_ROLE_PANEL_LIMITS.menus} menus.`, flags: MessageFlags.Ephemeral });
    }
    if (sub === 'delete') {
      const messageId = interaction.options.getString('message-id');
      const key = getCustomRolePanelKey(interaction.guildId,messageId);
      const panel = await db.get(key);
      if (!panel) return interaction.reply({ content: 'Panel not found.', flags: MessageFlags.Ephemeral });
      const channel = await interaction.guild.channels.fetch(panel.channelId).catch(()=>null);
      const message = await channel?.messages.fetch(messageId).catch(()=>null);
      await message?.delete().catch(()=>{});
      await db.delete(key);
      return interaction.reply({ content: '🗑️ Role panel deleted.', flags: MessageFlags.Ephemeral });
    }
    if (sub === 'list') {
      const keys = await db.list(`guild:${interaction.guildId}:bpanels:`);
      const allKeys = Array.isArray(keys) ? keys : (keys?.value || []);
      const panels = [];
      for (const key of allKeys) { const panel = await db.get(key); if (panel) panels.push(panel); }
      return interaction.reply({ content: panels.length ? panels.map(p => `• **${p.title}** — <#${p.channelId}> — \`${p.messageId}\` (${p.menus.length}/5 menus)`).join('\n') : 'No custom role panels found.', flags: MessageFlags.Ephemeral });
    }
  }
};
