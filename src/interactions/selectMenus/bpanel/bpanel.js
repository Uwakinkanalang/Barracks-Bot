import { EmbedBuilder, MessageFlags } from 'discord.js';
import { getCustomRolePanelKey, validateRoleForPanel } from '../../../services/customRolePanelService.js';

export async function execute(interaction, client) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!interaction.inGuild()) return interaction.editReply({ content: 'This menu only works inside a server.' });
  const menuId = interaction.customId.split(':')[1];
  const panel = await client.db.get(getCustomRolePanelKey(interaction.guildId,interaction.message.id));
  const menu = panel?.menus?.find(item => item.id === menuId);
  if (!menu) return interaction.editReply({ content: 'This role menu is no longer active. Please ask a staff member to refresh it.' });
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const botMember = interaction.guild.members.me ?? await interaction.guild.members.fetchMe();
  if (!botMember.permissions.has('ManageRoles')) return interaction.editReply({ content: 'I need Manage Roles permission to update your roles.' });
  const available = new Set(menu.options.map(option => option.roleId));
  const selected = new Set(interaction.values);
  const added = [], removed = [], skipped = [];
  for (const roleId of selected) {
    if (!available.has(roleId)) continue;
    const role = await interaction.guild.roles.fetch(roleId).catch(()=>null);
    const reason = validateRoleForPanel(role,interaction.guild);
    if (reason) { skipped.push(role?.name || roleId); continue; }
    if (!member.roles.cache.has(roleId)) {
      try { await member.roles.add(roleId); added.push(role.name); }
      catch { skipped.push(role.name); }
    }
  }
  for (const roleId of available) {
    if (selected.has(roleId) || !member.roles.cache.has(roleId)) continue;
    const role = interaction.guild.roles.cache.get(roleId);
    if (!role || role.position >= botMember.roles.highest.position) { skipped.push(role?.name || roleId); continue; }
    try { await member.roles.remove(roleId); removed.push(role.name); }
    catch { skipped.push(role.name); }
  }
  const lines = [];
  if (added.length) lines.push(`✅ Added: ${added.join(', ')}`);
  if (removed.length) lines.push(`➖ Removed: ${removed.join(', ')}`);
  if (skipped.length) lines.push(`⚠️ Skipped: ${skipped.join(', ')}`);
  if (!lines.length) lines.push('No role changes were needed.');
  return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x5865F2).setDescription(lines.join('\n'))] });
}
export default { execute };
