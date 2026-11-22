import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, PermissionFlagsBits } from 'discord.js';
import { listPendingEconomyWagers, recoverEconomyWager } from '../utils/economy.js';

export function canManageWagerRecovery(interaction) {
  const permissions = interaction.memberPermissions;
  return Boolean(permissions?.has(PermissionFlagsBits.ManageGuild) || permissions?.has(PermissionFlagsBits.Administrator));
}

function stateKey(guildId, userId) {
  return `guild:${guildId}:wager_recovery_selection:${userId}`;
}

export async function renderWagerRecoveryPanel(interaction, client, edit = false) {
  if (!interaction.inGuild() || !canManageWagerRecovery(interaction)) {
    const payload = { content: '⛔ You need **Manage Server** permission to access Wager Recovery.', embeds: [], components: [], ephemeral: true };
    if (edit) return interaction.editReply(payload);
    return interaction.reply(payload);
  }
  const result = await listPendingEconomyWagers(client, interaction.guildId, 25);
  const wagers = result.wagers || [];
  const embed = new EmbedBuilder()
    .setColor(0xD4A017)
    .setTitle('🪖 Barracks — Game Wager Recovery')
    .setDescription(wagers.length
      ? `Found **${result.total}** pending wager(s). Select one, then choose a recovery action.\n\nRefund returns the reserved stake. Settle as loss closes the wager with no payout.`
      : 'No pending wagers were found for this server.')
    .setFooter({ text: 'Staff only • Every recovery requires a reason and is recorded in the receipt.' });
  if (wagers.length) {
    embed.addFields(wagers.slice(0, 10).map((w) => ({
      name: `${w.game} • ${w.amount.toLocaleString()} bCash`,
      value: `Player: <@${w.userId}> • Created: <t:${Math.floor(w.createdAt / 1000)}:R>`,
      inline: false,
    })));
  }
  const rows = [];
  if (wagers.length) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId('wagerrecovery:select')
      .setPlaceholder('Select a pending wager')
      .addOptions(wagers.map((w) => ({
        label: `${w.game.slice(0, 45)} — ${w.amount.toLocaleString()} bCash`.slice(0, 100),
        description: `Player ${w.userId}`.slice(0, 100),
        value: `${w.userId}.${w.gameId}`.slice(0, 100),
      })));
    rows.push(new ActionRowBuilder().addComponents(menu));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('wagerrecovery:refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('wagerrecovery:refund').setLabel('Refund Stake').setStyle(ButtonStyle.Success).setDisabled(!wagers.length),
    new ButtonBuilder().setCustomId('wagerrecovery:settle').setLabel('Settle as Loss').setStyle(ButtonStyle.Danger).setDisabled(!wagers.length),
  ));
  const payload = { embeds: [embed], components: rows, ephemeral: true };
  if (edit) return interaction.editReply(payload);
  return interaction.reply(payload);
}

export async function handleWagerRecoveryButton(interaction, client, action) {
  if (!canManageWagerRecovery(interaction)) return interaction.reply({ content: '⛔ Manage Server permission is required.', ephemeral: true });
  if (action === 'refresh') {
    await interaction.deferUpdate();
    return renderWagerRecoveryPanel(interaction, client, true);
  }
  if (!['refund', 'settle'].includes(action)) return;
  const selected = await client.db.get(stateKey(interaction.guildId, interaction.user.id), null);
  if (!selected) return interaction.reply({ content: 'Select a pending wager first, then choose a recovery action.', ephemeral: true });
  const modal = await import('discord.js');
  const form = new modal.ModalBuilder().setCustomId(`wagerrecovery:reason:${action}`).setTitle(action === 'refund' ? 'Refund wager stake' : 'Settle wager as loss');
  const reason = new modal.TextInputBuilder().setCustomId('recovery_reason').setLabel('Reason for this staff action').setStyle(modal.TextInputStyle.Paragraph).setMinLength(5).setMaxLength(500).setRequired(true);
  form.addComponents(new modal.ActionRowBuilder().addComponents(reason));
  return interaction.showModal(form);
}

export async function handleWagerRecoverySelect(interaction, client) {
  if (!canManageWagerRecovery(interaction)) return interaction.reply({ content: '⛔ Manage Server permission is required.', ephemeral: true });
  const [userId, ...gameParts] = String(interaction.values?.[0] || '').split('.');
  const gameId = gameParts.join('.');
  if (!/^\d{17,20}$/.test(userId) || !gameId) return interaction.reply({ content: 'Invalid wager selection. Refresh the panel.', ephemeral: true });
  const pending = await listPendingEconomyWagers(client, interaction.guildId, 500);
  const match = pending.wagers.find((w) => w.userId === userId && w.gameId === gameId);
  if (!match) return interaction.reply({ content: 'That wager is no longer pending. Refresh the panel.', ephemeral: true });
  await client.db.set(stateKey(interaction.guildId, interaction.user.id), { userId, gameId, selectedAt: Date.now() });
  return interaction.reply({ content: `Selected **${match.game}** for <@${userId}> — **${match.amount.toLocaleString()} bCash**. Choose Refund Stake or Settle as Loss on the panel.`, ephemeral: true });
}

export async function handleWagerRecoveryModal(interaction, client) {
  if (!canManageWagerRecovery(interaction)) return interaction.reply({ content: '⛔ Manage Server permission is required.', ephemeral: true });
  const action = interaction.customId.split(':')[2];
  const selected = await client.db.get(stateKey(interaction.guildId, interaction.user.id), null);
  if (!selected || !['refund', 'settle'].includes(action)) return interaction.reply({ content: 'Your selection expired. Refresh the recovery panel and select the wager again.', ephemeral: true });
  await interaction.deferReply({ ephemeral: true });
  try {
    const result = await recoverEconomyWager(client, interaction.guildId, selected.userId, selected.gameId, {
      action: action === 'refund' ? 'refund' : 'settle_loss',
      actorId: interaction.user.id,
      reason: interaction.fields.getTextInputValue('recovery_reason'),
    });
    if (!result.recovered) {
      await interaction.editReply({ content: `No recovery performed: ${result.status}. Refresh the panel.` });
      return;
    }
    await client.db.delete(stateKey(interaction.guildId, interaction.user.id));
    await interaction.editReply({ content: `✅ Wager **${selected.gameId}** for <@${selected.userId}> was ${action === 'refund' ? 'refunded' : 'settled as a loss'}. Staff action recorded.` });
  } catch (error) {
    await interaction.editReply({ content: `Recovery failed safely: ${error.message}` });
  }
}
