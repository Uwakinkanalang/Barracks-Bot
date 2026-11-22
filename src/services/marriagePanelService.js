import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, UserSelectMenuBuilder, MessageFlags } from 'discord.js';
import {
  getMarriageData, getActiveMarriage, divorceMarriage,
  createMarriageProposal, resolveMarriageProposal, finalizeMarriageProposal, cancelMarriageProposal,
} from './marriageService.js';
import { validateMarriageEligibility, getFriendshipPoints } from './friendshipService.js';

const fmtDuration = ms => {
  const d = Math.max(0, Math.floor(ms / 86400000));
  const y = Math.floor(d / 365), m = Math.floor((d % 365) / 30), days = d % 30;
  return [y && y + 'y', m && m + 'mo', days + 'd'].filter(Boolean).join(' ');
};

export async function postMarriagePanel(interaction) {
  if (!interaction.memberPermissions?.has('ManageGuild')) return interaction.reply({ content: 'You need **Manage Server** permission to post this panel.', flags: MessageFlags.Ephemeral });
  const embed = new EmbedBuilder().setColor(0xE6B84A).setTitle('💍 Barracks Marriage Center')
    .setDescription('Manage your marriage, view the longest marriages, and review your relationship history.\n\nMarriage requires **1,000 FP** and an active Soulmate relationship.')
    .addFields(
      { name: 'My Marriage', value: 'View your spouse and marriage details.', inline: true },
      { name: 'Propose', value: 'Send a proposal to your eligible Soulmate.', inline: true },
      { name: 'Longest Marriages', value: 'See the longest active marriages.', inline: true },
      { name: 'Relationship History', value: 'Review past marriage records.', inline: true },
      { name: 'Divorce', value: 'End your marriage with confirmation.', inline: true },
    );
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('marriage:me').setLabel('My Marriage').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('marriage:propose').setLabel('Propose').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('marriage:leaderboard').setLabel('Longest Marriages').setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('marriage:history').setLabel('Relationship History').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('marriage:divorce').setLabel('Divorce').setStyle(ButtonStyle.Danger),
  );
  await interaction.channel.send({ embeds: [embed], components: [row1, row2] });
  return interaction.reply({ content: '💍 Marriage Center posted.', flags: MessageFlags.Ephemeral });
}

export async function handleMarriagePanelInteraction(interaction, client) {
  const id = interaction.customId, guildId = interaction.guildId, userId = interaction.user.id;
  if (id === 'marriage:propose') {
    const row = new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('marriage:select-propose').setPlaceholder('Select your Soulmate').setMinValues(1).setMaxValues(1));
    return interaction.reply({ content: 'Select your intended spouse. Both members must have **1,000 FP** and active Soulmate status. Proposal fee: **100,000 bCash**.', components: [row], flags: MessageFlags.Ephemeral });
  }
  if (id === 'marriage:select-propose') {
    const recipientId = interaction.values?.[0];
    const recipient = await interaction.guild?.members.fetch(recipientId).catch(() => null);
    if (!recipient || recipient.user.bot) return interaction.reply({ content: 'Choose a valid Barracks member. Bots cannot receive proposals.', flags: MessageFlags.Ephemeral });
    const result = await createMarriageProposal(client, guildId, userId, recipientId, {
      isBot: recipient.user.bot,
      validateEligibility: (a, b) => validateMarriageEligibility(client, guildId, a, b),
    });
    const errors = {
      not_eligible: result.reason || 'Both members need at least 1,000 FP and an active Soulmate relationship.',
      eligibility_service_unavailable: 'Eligibility checks are unavailable. No bCash was charged.',
      insufficient_funds: 'You need **100,000 bCash** in your wallet.',
      already_married: 'One of you is already married.',
      duplicate_pending: 'You already have a pending proposal to this member.',
      proposal_cooldown: 'You must wait before proposing to this member again.',
      remarriage_cooldown: 'One of you is still on the 7-day remarriage cooldown.',
      invalid_target: 'You cannot propose to yourself.',
      bot_target: 'Bots cannot receive marriage proposals.',
      payment_failed: 'Payment failed. No proposal was created.',
    };
    if (result.status !== 'created') return interaction.reply({ content: errors[result.status] || 'The proposal could not be created.', flags: MessageFlags.Ephemeral });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('marriage:proposal-accept:' + result.proposal.id).setLabel('Accept').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('marriage:proposal-decline:' + result.proposal.id).setLabel('Decline').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('marriage:proposal-cancel:' + result.proposal.id).setLabel('Cancel Proposal').setStyle(ButtonStyle.Secondary),
    );
    await interaction.channel.send({
      content: '<@' + recipientId + '> 💍 You have received a marriage proposal from <@' + userId + '>! The proposer paid **100,000 bCash**. This proposal expires in 7 days.',
      components: [row],
    });
    return interaction.reply({ content: '💍 Proposal sent! **100,000 bCash** has been charged. The recipient has been notified.', flags: MessageFlags.Ephemeral });
  }
  if (id.startsWith('marriage:proposal-')) {
    const [, action, proposalId] = id.split(':');
    if (action === 'proposal-accept') {
      const result = await finalizeMarriageProposal(client, guildId, proposalId, userId, {
        validateEligibility: (a, b) => validateMarriageEligibility(client, guildId, a, b),
      });
      const messages = {
        not_pending: 'This proposal is no longer pending.',
        not_authorized: 'Only the recipient can accept this proposal.',
        expired: 'This proposal has expired.',
        eligibility_service_unavailable: 'Eligibility checks are unavailable.',
        not_eligible: result.reason || 'The 1,000 FP and active Soulmate requirements are no longer met.',
        already_married: 'One of you is already married.',
        remarriage_cooldown: 'One of you is still on the 7-day remarriage cooldown.',
      };
      if (result.status !== 'married') return interaction.reply({ content: messages[result.status] || 'The proposal could not be accepted.', flags: MessageFlags.Ephemeral });
      await interaction.update({ content: '💍 <@' + result.marriage.member1Id + '> and <@' + result.marriage.member2Id + '> are now married in Barracks!', components: [] });
      return;
    }
    if (action === 'proposal-decline') {
      const result = await resolveMarriageProposal(client, guildId, proposalId, userId, 'declined');
      const messages = { declined: 'Proposal declined. The proposer will not receive a refund.', not_pending: 'This proposal is no longer pending.', not_authorized: 'Only the recipient can decline this proposal.', expired: 'This proposal has expired.' };
      if (result.status === 'declined' || result.status === 'expired') {
        return interaction.update({ content: messages[result.status], components: [] });
      }
      return interaction.reply({ content: messages[result.status] || 'Could not decline this proposal.', flags: MessageFlags.Ephemeral });
    }
    if (action === 'proposal-cancel') {
      const result = await cancelMarriageProposal(client, guildId, proposalId, userId);
      const messages = { cancelled: 'Proposal cancelled. The proposal fee is not refunded.', not_pending: 'This proposal is no longer pending.', not_authorized: 'Only the proposer can cancel this proposal.' };
      if (result.status === 'cancelled') return interaction.update({ content: messages.cancelled, components: [] });
      return interaction.reply({ content: messages[result.status] || 'Could not cancel this proposal.', flags: MessageFlags.Ephemeral });
    }
  }

  if (id === 'marriage:me') {
    const m = await getActiveMarriage(client, guildId, userId);
    if (!m) return interaction.reply({ content: 'You are not currently married in Barracks.', flags: MessageFlags.Ephemeral });
    const couplePoints = await getFriendshipPoints(client, guildId, userId, m.spouseId);
    const embed = new EmbedBuilder().setColor(0xE6B84A).setTitle('💍 Your Marriage').setDescription('You are married to <@' + m.spouseId + '>.')
      .addFields(
        { name: 'Wedding Date', value: '<t:' + Math.floor(m.marriedAt / 1000) + ':D>', inline: true },
        { name: 'Duration', value: fmtDuration(Date.now() - Number(m.marriedAt)), inline: true },
        { name: 'Couple FP', value: couplePoints.toLocaleString() + ' FP', inline: true },
        { name: 'Your Anniversary Rewards', value: '₱' + (Number(m.anniversaryRewards?.[userId]) || 0).toLocaleString(), inline: true },
      );
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (id === 'marriage:leaderboard') {
    const data = await getMarriageData(client, guildId);
    const rows = Object.values(data.marriages).filter(m => m?.status === 'married').sort((a,b) => Number(a.marriedAt)-Number(b.marriedAt)).slice(0,10);
    const desc = rows.length ? rows.map((m,i) => '**' + (i+1) + '.** <@' + m.member1Id + '> × <@' + m.member2Id + '> — ' + fmtDuration(Date.now()-Number(m.marriedAt))).join('\n') : 'No active marriages yet.';
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xE6B84A).setTitle('🏆 Longest Marriages').setDescription(desc)], flags: MessageFlags.Ephemeral });
  }

  if (id === 'marriage:history') {
    const data = await getMarriageData(client, guildId);
    const rows = data.history.filter(r => r.member1Id === userId || r.member2Id === userId).sort((a,b) => Number(b.marriedAt||b.divorcedAt||b.updatedAt||0)-Number(a.marriedAt||a.divorcedAt||a.updatedAt||0)).slice(0,10);
    const desc = rows.length ? rows.map(r => r.type === 'marriage' ? '💍 Married <@' + r.member1Id + '> × <@' + r.member2Id + '> — <t:' + Math.floor(r.marriedAt/1000) + ':D>' : r.type === 'divorce' ? '💔 Divorce — <t:' + Math.floor(r.divorcedAt/1000) + ':D>' : '📜 Proposal: **' + r.status + '**').join('\n') : 'No marriage history found.';
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xE6B84A).setTitle('📜 Relationship History').setDescription(desc)], flags: MessageFlags.Ephemeral });
  }

  if (id === 'marriage:divorce') {
    const m = await getActiveMarriage(client, guildId, userId);
    if (!m) return interaction.reply({ content: 'You do not have an active marriage.', flags: MessageFlags.Ephemeral });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('marriage:divorce-confirm').setLabel('Confirm Divorce — 100,000 bCash').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('marriage:divorce-cancel').setLabel('Keep Marriage').setStyle(ButtonStyle.Secondary),
    );
    return interaction.reply({ content: 'Divorce <@' + m.spouseId + '>? You pay **100,000 bCash**. Both spouses receive a 7-day remarriage cooldown.', components: [row], flags: MessageFlags.Ephemeral });
  }
  if (id === 'marriage:divorce-cancel') return interaction.update({ content: 'Divorce cancelled. Your marriage remains active.', components: [] });
  if (id === 'marriage:divorce-confirm') {
    const result = await divorceMarriage(client, guildId, userId, { confirmed: true });
    if (result.status !== 'divorced') {
      const messages = { not_married: 'You are not currently married.', insufficient_funds: 'You need **100,000 bCash** in your wallet.', payment_failed: 'Payment failed. Your marriage remains active.' };
      return interaction.update({ content: messages[result.status] || 'Divorce could not be completed.', components: [] });
    }
    await interaction.update({ content: '💔 Divorce finalized. **100,000 bCash** was deducted. Your 7-day remarriage cooldown has started.', components: [] });
    await interaction.channel?.send({
      content: '💔 Marriage ended: <@' + result.initiatorId + '> and <@' + result.spouseId + '> are now divorced. The initiating spouse paid **100,000 bCash**. Both members have a 7-day remarriage cooldown.',
    }).catch(() => {});
    return;
  }
}
