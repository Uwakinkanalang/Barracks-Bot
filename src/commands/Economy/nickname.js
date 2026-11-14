import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    MessageFlags,
} from 'discord.js';
import { SlashCommandBuilder } from 'discord.js';
import { getEconomyData, setEconomyData } from '../../utils/economy.js';

const NICKNAME_CHANGE_PRICE = 500000;

function getClanPrefix(currentNickname = '') {
    const current = String(currentNickname || '').trim();
    if (!current) return '';

    // Preserve common clan-tag formats such as [TAG] Name, 『TAG』 Name,
    // ★ Name, or TAG | Name. Only keep a short leading marker, not the old name.
    const wrapped = current.match(/^(\[[^\]]{1,8}\]|【[^】]{1,8}】|『[^』]{1,8}』|「[^」]{1,8}」|〈[^〉]{1,8}〉|\([^)]{1,8}\))(?=\s|[|・•丨])/u);
    if (wrapped) return wrapped[1];

    const separated = current.match(/^([^|・•丨]{1,8})\s*[|・•丨]/u);
    if (separated) return separated[1].trim();

    const firstToken = current.match(/^([^\s]{1,6})\s+/u);
    if (firstToken && /[^\p{L}\p{N}_-]/u.test(firstToken[1])) return firstToken[1];

    return '';
}

function applyClanPrefix(member, requestedNickname) {
    const prefix = getClanPrefix(member.nickname || member.displayName);
    if (!prefix) return requestedNickname;
    if (requestedNickname.startsWith(prefix)) return requestedNickname;
    return `${prefix} ${requestedNickname}`.trim();
}

export default {
    prefixOnly: true,
    data: new SlashCommandBuilder()
        .setName('nickname')
        .setDescription('Open the bCash nickname change panel'),

    async execute(interaction) {
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('✏️ BARRACKS • NICKNAME CHANGE')
            .setDescription(
                'Want a new identity in the Barracks? Change your server nickname using bCash.\n\n' +
                '**Service Price**\n' +
                '💰 **₱500,000 bCash**\n\n' +
                'Click the button below to enter your new nickname. Your bCash will only be charged if the nickname is changed successfully.'
            )
            .setFooter({ text: 'Barracks • Nickname Services' });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('barracks_nickname_change')
                .setLabel('Change Nickname')
                .setEmoji('✏️')
                .setStyle(ButtonStyle.Primary)
        );

        // This is a prefix-only command. Send the panel directly to the channel
        // instead of relying on the mock interaction reply/fetchReply adapter.
        const panelMessage = await interaction.channel.send({ embeds: [embed], components: [row] });
        const collector = panelMessage.createMessageComponentCollector({ time: 300000 });

        collector.on('collect', async buttonInteraction => {
            if (buttonInteraction.customId !== 'barracks_nickname_change') return;
            const modal = new ModalBuilder()
                .setCustomId('barracks_nickname_modal')
                .setTitle('Change Server Nickname');

            const nicknameInput = new TextInputBuilder()
                .setCustomId('nickname')
                .setLabel('Enter your new nickname')
                .setPlaceholder('Your new Barracks nickname')
                .setStyle(TextInputStyle.Short)
                .setMinLength(1)
                .setMaxLength(32)
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder().addComponents(nicknameInput));
            await buttonInteraction.showModal(modal);

            try {
                const submitted = await buttonInteraction.awaitModalSubmit({
                    time: 120000,
                    filter: modalInteraction =>
                        modalInteraction.customId === 'barracks_nickname_modal' &&
                        modalInteraction.user.id === buttonInteraction.user.id,
                });

                const requestedNickname = submitted.fields.getTextInputValue('nickname').trim();
                if (!requestedNickname || requestedNickname.length > 32) {
                    await submitted.reply({
                        content: 'Please enter a nickname between 1 and 32 characters.',
                        flags: [MessageFlags.Ephemeral],
                    });
                    return;
                }

                const member = await interaction.guild.members.fetch(submitted.user.id);
                if (!member.manageable) {
                    await submitted.reply({
                        content: 'I cannot change your nickname. Please make sure my role is above your highest role.',
                        flags: [MessageFlags.Ephemeral],
                    });
                    return;
                }

                const newNickname = applyClanPrefix(member, requestedNickname);
                if (newNickname.length > 32) {
                    await submitted.reply({
                        content: `Your clan tag would make that nickname exceed Discord's 32-character limit. Please enter a shorter nickname.`,
                        flags: [MessageFlags.Ephemeral],
                    });
                    return;
                }

                const userData = await getEconomyData(interaction.client || interaction.guild.client, interaction.guildId, submitted.user.id);
                if (!userData || userData.wallet < NICKNAME_CHANGE_PRICE) {
                    const balance = Number(userData?.wallet) || 0;
                    await submitted.reply({
                        content: `❌ You need **₱${NICKNAME_CHANGE_PRICE.toLocaleString()} bCash**, but your wallet only has **₱${balance.toLocaleString()}**.`,
                        flags: [MessageFlags.Ephemeral],
                    });
                    return;
                }

                try {
                    await member.setNickname(newNickname, 'Purchased nickname change with bCash');
                } catch (error) {
                    await submitted.reply({
                        content: '❌ Discord could not update your nickname. No bCash was deducted.',
                        flags: [MessageFlags.Ephemeral],
                    });
                    return;
                }

                userData.wallet -= NICKNAME_CHANGE_PRICE;
                const saved = await setEconomyData(interaction.client || interaction.guild.client, interaction.guildId, submitted.user.id, userData);
                if (!saved) {
                    await submitted.reply({
                        content: 'Your nickname was changed, but the payment could not be saved. Please contact a server administrator.',
                        flags: [MessageFlags.Ephemeral],
                    });
                    return;
                }

                await submitted.reply({
                    content: `✅ Your server nickname has been changed to **${newNickname}**.\n💸 **Amount Paid:** ₱${NICKNAME_CHANGE_PRICE.toLocaleString()} bCash\n💰 **Remaining Balance:** ₱${userData.wallet.toLocaleString()}`,
                    flags: [MessageFlags.Ephemeral],
                });
            } catch (error) {
                // The member closed the modal or it expired; no charge is made.
            }
        });

        collector.on('end', async () => {
            await panelMessage.edit({ components: [] }).catch(() => {});
        });
    },
};
