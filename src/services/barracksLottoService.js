import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { randomInt } from 'node:crypto';
import { getEconomyData, setEconomyData } from '../utils/economy.js';

export const LOTTO_PRICE = 20000;
const DRAW_INTERVAL = 24 * 60 * 60 * 1000;
const keyFor = guildId => `guild:${guildId}:barracksLotto`;
const locks = new Set();

function freshState() {
  return { tickets: [], jackpot: 0, nextDrawAt: Date.now() + DRAW_INTERVAL, totalDraws: 0, winners: [], panel: null, houseTotal: 0 };
}

export function buildLottoPanel(state) {
  const remaining = Math.max(0, state.nextDrawAt - Date.now());
  const hours = Math.floor(remaining / 3600000);
  const minutes = Math.floor((remaining % 3600000) / 60000);
  const bannerUrl = process.env.BARRACKS_LOTTO_BANNER_URL || 'https://cdn.discordapp.com/attachments/1572883657440366673/1573007614541963364/Makukulay_na_Barracks_Lotto_Game_Banner.png?ex=6b007100&is=6aff1f80&hm=1d3e2d7fe9e8b741aa5cddb82454daef75fd4af328e63f97d86876fa5583f64a&';
  const embed = new EmbedBuilder()
    .setColor(0xD4A017)
    .setTitle('🎖️ BARRACKS LOTTO')
    .setDescription(
      '**TRY YOUR LUCK, SOLDIER!**\n' +
      'Join the draw, collect your tickets, and stand a chance to claim the prize.\n\n' +
      '🎟️ **One button click = one ticket**\n' +
      '🪖 **Multiple entries are allowed**\n' +
      '🏆 **Winner is selected randomly**'
    )
    .addFields(
      { name: '💰 Current Jackpot', value: `₱${Number(state.jackpot || 0).toLocaleString()} bCash`, inline: true },
      { name: '🎫 Ticket Cost', value: `₱${LOTTO_PRICE.toLocaleString()} bCash`, inline: true },
      { name: '🎟️ Total Entries', value: String(state.tickets?.length || 0), inline: true },
      { name: '⏰ Next Draw', value: `${hours}h ${minutes}m`, inline: true },
    )
    .setFooter({ text: 'BARRACKS • LOTTO PANEL V2 • Good luck, soldier!' })
    .setTimestamp();
  if (bannerUrl) embed.setImage(bannerUrl);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('barracksLotto:enter').setLabel('ENTER LOTTO').setEmoji('🎟️').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('barracksLotto:mine').setLabel('MY TICKETS').setEmoji('👤').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('barracksLotto:winners').setLabel('WINNERS').setEmoji('🏆').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('barracksLotto:info').setLabel('HOW TO PLAY').setEmoji('📋').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

export async function getLottoState(client, guildId) {
  return (await client.db.get(keyFor(guildId), null)) || freshState();
}
async function save(client, guildId, state) {
  await client.db.set(keyFor(guildId), state);
}
async function refreshPanel(client, guildId, state) {
  if (!state.panel?.channelId || !state.panel?.messageId) return;
  const channel = await client.channels.fetch(state.panel.channelId).catch(() => null);
  const message = await channel?.messages.fetch(state.panel.messageId).catch(() => null);
  if (message) await message.edit(buildLottoPanel(state)).catch(() => {});
}
async function settleDraw(client, guildId, state) {
  if (!state.tickets.length) {
    state.winners.unshift({ winnerId: null, prize: 0, drawnAt: Date.now(), entries: 0 });
  } else {
    const ticket = state.tickets[randomInt(state.tickets.length)];
    const prize = Math.floor(state.jackpot);
    const account = await getEconomyData(client, guildId, ticket.userId);
    account.wallet = (Number(account.wallet) || 0) + prize;
    const saved = await setEconomyData(client, guildId, ticket.userId, account);
    if (!saved) throw new Error('Unable to save lotto winner payout');
    state.winners.unshift({ winnerId: ticket.userId, prize, drawnAt: Date.now(), entries: state.tickets.length });
    state.lastWinnerId = ticket.userId;
    state.lastPrize = prize;
  }
  state.winners = state.winners.slice(0, 10);
  state.totalDraws = (state.totalDraws || 0) + 1;
  state.tickets = [];
  state.jackpot = 0;
  state.nextDrawAt = Date.now() + DRAW_INTERVAL;
  await save(client, guildId, state);
  await refreshPanel(client, guildId, state);
}
export async function runLottoDraws(client) {
  const keys = await client.db.list('guild:');
  const list = Array.isArray(keys) ? keys : Object.keys(keys || {});
  for (const key of list.filter(value => /^guild:\d+:barracksLotto$/.test(value))) {
    const guildId = key.split(':')[1];
    if (locks.has(guildId)) continue;
    locks.add(guildId);
    try {
      const state = await getLottoState(client, guildId);
      if (Date.now() >= Number(state.nextDrawAt || 0)) await settleDraw(client, guildId, state);
      else await refreshPanel(client, guildId, state);
    } catch (error) {
      console.error('[LOTTO] Draw processing failed:', error);
    } finally { locks.delete(guildId); }
  }
}
export async function handleLottoButton(interaction, client) {
  if (!interaction.customId.startsWith('barracksLotto:')) return false;
  const action = interaction.customId.split(':')[1];
  const guildId = interaction.guildId;
  if (!guildId) { await interaction.reply({ content: 'This panel only works inside a server.', ephemeral: true }); return true; }
  if (locks.has(guildId)) { await interaction.reply({ content: 'The lotto is processing. Please try again.', ephemeral: true }); return true; }
  locks.add(guildId);
  try {
    const state = await getLottoState(client, guildId);
    if (Date.now() >= Number(state.nextDrawAt || 0)) await settleDraw(client, guildId, state);
    if (action === 'enter') {
      const account = await getEconomyData(client, guildId, interaction.user.id);
      if ((Number(account.wallet) || 0) < LOTTO_PRICE) {
        await interaction.reply({ content: `Not enough bCash in your wallet. You need **₱${LOTTO_PRICE.toLocaleString()}**. Your wallet: **₱${(Number(account.wallet) || 0).toLocaleString()}**.`, ephemeral: true });
        return true;
      }
      account.wallet -= LOTTO_PRICE;
      if (!await setEconomyData(client, guildId, interaction.user.id, account)) {
        await interaction.reply({ content: 'Your entry could not be saved. No bCash was deducted.', ephemeral: true });
        return true;
      }
      state.tickets.push({ userId: interaction.user.id, enteredAt: Date.now() });
      state.jackpot += Math.floor(LOTTO_PRICE * 0.9);
      state.houseTotal = (state.houseTotal || 0) + Math.ceil(LOTTO_PRICE * 0.1);
      await save(client, guildId, state);
      await interaction.reply({ content: `🎟️ **Entry confirmed!** You purchased 1 Barracks Lotto ticket for **₱${LOTTO_PRICE.toLocaleString()}**.\nYour remaining wallet: **₱${account.wallet.toLocaleString()}**. Good luck, soldier!`, ephemeral: true });
      await refreshPanel(client, guildId, state);
    } else if (action === 'mine') {
      const count = state.tickets.filter(ticket => ticket.userId === interaction.user.id).length;
      await interaction.reply({ content: `🎟️ You currently have **${count}** ticket(s) in this draw.`, ephemeral: true });
    } else if (action === 'winners') {
      const lines = (state.winners || []).map((winner, index) => winner.winnerId ? `**${index + 1}.** <@!${winner.winnerId}> — ₱${Number(winner.prize).toLocaleString()} (${winner.entries} entries)` : `**${index + 1}.** No winner — no entries were submitted.`);
      await interaction.reply({ content: lines.length ? `🏆 **Previous Barracks Lotto Winners**\n${lines.join('\n')}` : 'No previous winners yet, soldier.', ephemeral: true });
    } else if (action === 'info') {
      await interaction.reply({ content: `🎟️ **Barracks Lotto Rules**\n• Each ticket costs **₱${LOTTO_PRICE.toLocaleString()} bCash**.\n• Click Enter Lotto to buy one ticket.\n• You may enter multiple times.\n• Draw happens every 24 hours.\n• 90% of ticket sales goes into the jackpot; 10% is retained by the house.\n• The winner is selected randomly and paid automatically to their wallet.\n• Entries are final and non-refundable.`, ephemeral: true });
    }
    return true;
  } catch (error) {
    console.error('[LOTTO] Button failed:', error);
    if (interaction.deferred || interaction.replied) await interaction.followUp({ content: 'Something went wrong processing your lotto request. Please contact staff if bCash was affected.', ephemeral: true }).catch(() => {});
    else await interaction.reply({ content: 'Something went wrong. Please try again later.', ephemeral: true }).catch(() => {});
    return true;
  } finally { locks.delete(guildId); }
}
export async function createLottoPanel(message, client) {
  const state = await getLottoState(client, message.guild.id);
  if (Date.now() >= Number(state.nextDrawAt || 0)) state.nextDrawAt = Date.now() + DRAW_INTERVAL;
  const posted = await message.channel.send(buildLottoPanel(state));
  state.panel = { channelId: posted.channelId, messageId: posted.id };
  await save(client, message.guild.id, state);
  return posted;
}
