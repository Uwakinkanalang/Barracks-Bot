import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  UserSelectMenuBuilder, MessageFlags,
} from 'discord.js';
import {
  getFriendshipData, getActiveFriends, getFriendshipPoints,
  sendFriendRequest, resolveFriendRequest, cancelFriendRequest, removeFriend, claimFriendshipDailyBonus,
  createSoulmateRequest, resolveSoulmateRequest, endSoulmate, getActiveSoulmate,
  blockFriendshipMember, unblockFriendshipMember,
} from './friendshipService.js';

const ephemeral = { flags: MessageFlags.Ephemeral };
export async function postFriendshipPanel(interaction) {
  if (!interaction.memberPermissions?.has('ManageGuild')) {
    return interaction.reply({ content: 'You need **Manage Server** permission to post this panel.', ...ephemeral });
  }
  const embed = new EmbedBuilder().setColor(0xD6A632).setTitle('🫂 Barracks Friendship Center')
    .setDescription('Build friendships, earn Friendship Points, and become Soulmates.\n\n**Chat:** +1 FP • **Voice:** +3 FP • **Daily pair bonus:** +5 FP\n**Daily cap:** 30 FP per pair.')
    .addFields(
      { name: 'My Friends', value: 'View friends and friendship levels.', inline: true },
      { name: 'Add Friend', value: 'Send a request to another soldier.', inline: true },
      { name: 'Requests', value: 'Review incoming and outgoing requests.', inline: true },
      { name: 'Soulmates', value: 'Start or view a Soulmate relationship.', inline: true },
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('friendship:friends').setLabel('My Friends').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('friendship:add').setLabel('Add Friend').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('friendship:requests').setLabel('Requests').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('friendship:soulmate').setLabel('Soulmates').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('friendship:leaderboard').setLabel('Leaderboard').setStyle(ButtonStyle.Secondary),
  );
  const safetyRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('friendship:block').setLabel('Block Member').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('friendship:unblock').setLabel('Unblock Member').setStyle(ButtonStyle.Secondary),
  );
  await interaction.channel.send({ embeds: [embed], components: [row, safetyRow] });
  return interaction.reply({ content: '🫂 Friendship Center posted.', ...ephemeral });
}

function friendLevel(points) {
  if (points >= 1000) return 'Marriage Eligible';
  if (points >= 800) return 'Soulmates';
  if (points >= 500) return 'Best Friends';
  if (points >= 300) return 'Close Friends';
  if (points >= 150) return 'Friends';
  if (points >= 50) return 'Acquaintances';
  return 'Strangers';
}

export async function handleFriendshipInteraction(interaction, client) {
  const id = interaction.customId, guildId = interaction.guildId, userId = interaction.user.id;
  if (id === 'friendship:block') {
    const row = new ActionRowBuilder().addComponents(new UserSelectMenuBuilder()
      .setCustomId('friendship:select-block').setPlaceholder('Select a member to block').setMinValues(1).setMaxValues(1));
    return interaction.reply({ content: 'Blocked members cannot send you new friendship or Soulmate requests.', components: [row], ...ephemeral });
  }
  if (id === 'friendship:select-block') {
    const targetId = interaction.values?.[0];
    if (targetId === userId) return interaction.reply({ content: 'You cannot block yourself.', ...ephemeral });
    const result = await blockFriendshipMember(client, guildId, userId, targetId);
    return interaction.reply({ content: result.status === 'blocked' ? 'Member blocked. They cannot send you friendship or Soulmate requests.' : 'Could not block that member.', ...ephemeral });
  }
  if (id === 'friendship:unblock') {
    const data = await getFriendshipData(client, guildId);
    const blocked = Array.isArray(data.blocks[userId]) ? data.blocks[userId] : [];
    if (!blocked.length) return interaction.reply({ content: 'You have no blocked members.', ...ephemeral });
    const row = new ActionRowBuilder().addComponents(new UserSelectMenuBuilder()
      .setCustomId('friendship:select-unblock').setPlaceholder('Select a member to unblock').setMinValues(1).setMaxValues(1));
    return interaction.reply({ content: 'Select the member you want to unblock.', components: [row], ...ephemeral });
  }
  if (id === 'friendship:select-unblock') {
    const targetId = interaction.values?.[0];
    const result = await unblockFriendshipMember(client, guildId, userId, targetId);
    return interaction.reply({ content: result.status === 'unblocked' ? 'Member unblocked.' : 'Could not unblock that member.', ...ephemeral });
  }
  if (id === 'friendship:add') {
    const row = new ActionRowBuilder().addComponents(new UserSelectMenuBuilder()
      .setCustomId('friendship:select-add').setPlaceholder('Select a Barracks member').setMinValues(1).setMaxValues(1));
    return interaction.reply({ content: 'Choose the member you want to add as a friend.', components: [row], ...ephemeral });
  }
  if (id === 'friendship:select-add') {
    const targetId = interaction.values?.[0];
    const target = await interaction.guild?.members.fetch(targetId).catch(() => null);
    if (!target || target.user.bot) return interaction.reply({ content: 'Choose a valid member. Bots cannot be friends.', ...ephemeral });
    const result = await sendFriendRequest(client, guildId, userId, targetId, { isBot: target.user.bot });
    if (result.status !== 'created') {
      const messages = { invalid_target: 'You cannot add yourself.', bot_target: 'Bots cannot be added.', already_friends: 'You are already friends.', duplicate_pending: 'A request is already pending between you.', blocked: 'A friendship request cannot be sent because one of you has blocked the other.' };
      return interaction.reply({ content: messages[result.status] || 'Could not send the request.', ...ephemeral });
    }
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('friendship:accept:' + result.request.id).setLabel('Accept').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('friendship:decline:' + result.request.id).setLabel('Decline').setStyle(ButtonStyle.Danger),
    );
    await interaction.channel.send({ content: '<@' + targetId + '> 🫂 <@' + userId + '> sent you a friendship request. It expires in 7 days.', components: [row] });
    return interaction.reply({ content: 'Friend request sent!', ...ephemeral });
  }
  if (id.startsWith('friendship:accept:') || id.startsWith('friendship:decline:')) {
    const [action, requestId] = id.startsWith('friendship:accept:') ? ['accepted', id.slice('friendship:accept:'.length)] : ['declined', id.slice('friendship:decline:'.length)];
    const result = await resolveFriendRequest(client, guildId, requestId, userId, action);
    const messages = { accepted: '🫂 Friendship accepted! Your previous friendship progress has been restored if this is a re-connection.', declined: 'Friend request declined.', not_pending: 'This request is no longer pending.', not_authorized: 'Only the recipient can respond.', expired: 'This request has expired.' };
    if (result.status === 'accepted' || result.status === 'declined') return interaction.update({ content: messages[result.status], components: [] });
    return interaction.reply({ content: messages[result.status] || 'Could not process this request.', ...ephemeral });
  }
  if (id === 'friendship:friends') {
    const friends = await getActiveFriends(client, guildId, userId);
    if (!friends.length) return interaction.reply({ content: 'You have no active friendships yet. Send a friend request to get started!', ...ephemeral });
    const lines = await Promise.all(friends.slice(0, 20).map(async friend => {
      const points = await getFriendshipPoints(client, guildId, userId, friend.friendId);
      return '<@' + friend.friendId + '> — **' + points.toLocaleString() + ' FP** (' + friendLevel(points) + ')';
    }));
    const removeRow = new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('friendship:select-remove').setPlaceholder('Select a friend to remove').setMinValues(1).setMaxValues(1));
    const dailyRow = new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('friendship:select-daily').setPlaceholder('Claim +5 daily FP with a friend').setMinValues(1).setMaxValues(1));
    return interaction.reply({ content: '**Your Friends**\n' + lines.join('\n') + '\n\nChoose a friend below to claim the pair daily bonus (+5 FP) or remove them. Re-adding a removed friend restores their history.', components: [dailyRow, removeRow], ...ephemeral });
  }
  if (id === 'friendship:select-daily') {
    const targetId = interaction.values?.[0];
    const result = await claimFriendshipDailyBonus(client, guildId, userId, targetId);
    const messages = { claimed: '🎖️ Daily friendship bonus claimed: **+' + result.points + ' FP**. Your pair total is **' + result.total + ' FP**.', already_claimed: 'You have already claimed today’s friendship bonus with this member.', not_friends: 'You are not currently friends with that member.' };
    return interaction.reply({ content: messages[result.status] || 'Could not claim the friendship bonus.', ...ephemeral });
  }
  if (id === 'friendship:select-remove') {
    const targetId = interaction.values?.[0];
    const result = await removeFriend(client, guildId, userId, targetId);
    return interaction.reply({ content: result.status === 'removed' ? 'Friend removed. Your Friendship Points and history are saved.' : 'That member is not in your active friends list.', ...ephemeral });
  }
  if (id.startsWith('friendship:cancel:')) {
    const requestId = id.slice('friendship:cancel:'.length);
    const result = await cancelFriendRequest(client, guildId, requestId, userId);
    return interaction.reply({ content: result.status === 'cancelled' ? 'Friend request cancelled.' : 'This request can no longer be cancelled.', ...ephemeral });
  }
  if (id === 'friendship:requests') {
    const data = await getFriendshipData(client, guildId);
    const incoming = Object.values(data.requests).filter(r => r?.kind !== 'soulmate' && r?.status === 'pending' && r.recipientId === userId);
    const outgoing = Object.values(data.requests).filter(r => r?.kind !== 'soulmate' && r?.status === 'pending' && r.senderId === userId);
    const text = [
      '**Incoming**',
      ...(incoming.slice(0, 10).map(r => '• <@' + r.senderId + '> — expires <t:' + Math.floor(r.expiresAt / 1000) + ':R>')),
      '**Outgoing**',
      ...(outgoing.slice(0, 5).map(r => '• <@' + r.recipientId + '> — expires <t:' + Math.floor(r.expiresAt / 1000) + ':R>')),
    ].join('\n');
    const cancelRow = outgoing.length ? new ActionRowBuilder().addComponents(
      ...outgoing.slice(0, 5).map(r => new ButtonBuilder().setCustomId('friendship:cancel:' + r.id).setLabel('Cancel → ' + String(r.recipientId).slice(-4)).setStyle(ButtonStyle.Secondary))
    ) : null;
    return interaction.reply({ content: text, components: cancelRow ? [cancelRow] : [], ...ephemeral });
  }
  if (id === 'friendship:soulmate') {
    const soulmate = await getActiveSoulmate(client, guildId, userId);
    if (soulmate) {
      const other = soulmate.member1Id === userId ? soulmate.member2Id : soulmate.member1Id;
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('friendship:soulmate-end').setLabel('End Soulmate Relationship').setStyle(ButtonStyle.Danger));
      return interaction.reply({ content: '💞 Your Soulmate is <@' + other + '>. Started <t:' + Math.floor(soulmate.startedAt / 1000) + ':D>.', components: [row], ...ephemeral });
    }
    const row = new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('friendship:select-soulmate').setPlaceholder('Choose your Soulmate').setMinValues(1).setMaxValues(1));
    return interaction.reply({ content: 'You need at least **800 FP** with a friend. Both members must be free of an active Soulmate relationship.', components: [row], ...ephemeral });
  }
  if (id === 'friendship:select-soulmate') {
    const targetId = interaction.values?.[0];
    const target = await interaction.guild?.members.fetch(targetId).catch(() => null);
    if (!target || target.user.bot) return interaction.reply({ content: 'Choose a valid member. Bots cannot be Soulmates.', ...ephemeral });
    const result = await createSoulmateRequest(client, guildId, userId, targetId, { isBot: target.user.bot });
    const messages = { not_friends: 'You must be friends first.', insufficient_points: 'You need at least 800 FP together.', already_soulmates: 'One of you already has an active Soulmate.', cooldown: 'One of you is still on the 7-day Soulmate cooldown.', duplicate_pending: 'A Soulmate request is already pending.', blocked: 'A Soulmate request cannot be sent because one of you has blocked the other.' };
    if (result.status !== 'created') return interaction.reply({ content: messages[result.status] || 'Could not send a Soulmate request.', ...ephemeral });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('friendship:soulmate-accept:' + result.request.id).setLabel('Accept').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('friendship:soulmate-decline:' + result.request.id).setLabel('Decline').setStyle(ButtonStyle.Danger),
    );
    await interaction.channel.send({ content: '<@' + targetId + '> 💞 <@' + userId + '> wants to become your Soulmate! Request expires in 7 days.', components: [row] });
    return interaction.reply({ content: 'Soulmate request sent!', ...ephemeral });
  }
  if (id.startsWith('friendship:soulmate-accept:') || id.startsWith('friendship:soulmate-decline:')) {
    const accepted = id.startsWith('friendship:soulmate-accept:');
    const requestId = id.slice(accepted ? 'friendship:soulmate-accept:'.length : 'friendship:soulmate-decline:'.length);
    const result = await resolveSoulmateRequest(client, guildId, requestId, userId, accepted ? 'accepted' : 'declined');
    const messages = { accepted: '💞 You are now Soulmates!', declined: 'Soulmate request declined.', not_pending: 'This request is no longer pending.', not_authorized: 'Only the recipient can respond.', expired: 'This request has expired.', not_eligible: 'The 800 FP friendship requirement is no longer met.', already_soulmates: 'One of you already has an active Soulmate.', cooldown: 'One of you is still on the 7-day Soulmate cooldown.', blocked: 'One of you has blocked the other.' };
    if (result.status === 'accepted' || result.status === 'declined') return interaction.update({ content: messages[result.status], components: [] });
    return interaction.reply({ content: messages[result.status] || 'Could not process this request.', ...ephemeral });
  }
  if (id === 'friendship:soulmate-end') {
    const result = await endSoulmate(client, guildId, userId);
    return interaction.update({ content: result.status === 'ended' ? 'Soulmate relationship ended. Both members have a 7-day cooldown.' : 'You do not have an active Soulmate relationship.', components: [] });
  }
  if (id === 'friendship:leaderboard') {
    const data = await getFriendshipData(client, guildId);
    const rows = Object.values(data.friendships).filter(p => p?.active).sort((a,b) => Number(b.points)-Number(a.points)).slice(0,10);
    const text = rows.length ? rows.map((p,i) => '**' + (i+1) + '.** <@' + p.member1Id + '> × <@' + p.member2Id + '> — **' + (Number(p.points)||0).toLocaleString() + ' FP**').join('\n') : 'No active friendships yet.';
    return interaction.reply({ content: '🏆 **Top Friendships**\n' + text, ...ephemeral });
  }
}
