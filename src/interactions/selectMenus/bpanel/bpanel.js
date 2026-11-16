import { getCustomRolePanelKey, validateRoleForPanel } from '../../../services/customRolePanelService.js';

export async function execute(interaction, client) {
  await interaction.deferUpdate();
  if (!interaction.inGuild()) return;
  const menuId = interaction.customId.split(':')[1];
  const panel = await client.db.get(getCustomRolePanelKey(interaction.guildId,interaction.message.id));
  const menu = panel?.menus?.find(item => item.id === menuId);
  if (!menu) return;
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const botMember = interaction.guild.members.me ?? await interaction.guild.members.fetchMe();
  if (!botMember.permissions.has('ManageRoles')) return;
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
  // Intentionally do not send a confirmation message after role selection.
  return;
}
export default { name: 'bpanel', execute };
