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

const NICKNAME_CHANGE_PRICE = 300000;

const DEPARTMENT_PREFIXES = [
    ['1557783753982480445', '🍋| '],
    ['1557784202844446750', '☕| '],
    ['1557784505362677892', '💼| '],
    ['1557784711072579706', '🍎| '],
    ['1557784915876257957', '🥒| '],
    ['1557785136462831766', '⚖| '],
    ['1557785381213311027', '🥥| '],
];

const RANK_PREFIXES = [
    ['1467461731998761096', '🔫ᴾʳⁱᵛᵃᵗᵉ '],
    ['1467461918792089784', '🔫ᶜᵒʳᵖᵒʳᵃˡ '],
    ['1467461953340444677', '🔫ˢᵉʳᵍᵉᵃⁿᵗ '],
    ['1540715496637333564', '🔫ᶜᵃᵖᵗᵃⁱⁿ '],
    ['1467462639759396865', '🔫ᴸⁱᵉᵘᵗᵉⁿᵃⁿᵗ '],
    ['1467462740024098983', '🔫ᴹᵃʲᵒʳ '],
    ['1467462823457063067', '🔫ᶜᵒˡᵒⁿᵉˡ '],
    ['1467462861822627912', '🔫ᴳᵉⁿᵉʳᵃˡ '],
];

export async function getNicknamePrefix(member, client, guildId) {
    // Department roles always take priority.
    const department = DEPARTMENT_PREFIXES.find(([roleId]) => member.roles.cache.has(roleId));
    if (department) return department[1];

    // Clan registry stores each clan's tag and the role created after approval.
    const clans = await client.db.get(`guild:${guildId}:clans`, []);
    if (Array.isArray(clans)) {
        const clan = clans.find(entry =>
            entry.status === 'approved' &&
            entry.roleId &&
            member.roles.cache.has(entry.roleId) &&
            (entry.leaderId === member.id ||
                entry.viceLeaderId === member.id ||
                (Array.isArray(entry.memberIds) && entry.memberIds.includes(member.id)))
        );
        if (clan?.tag) return `${clan.tag} `;
    }

    // Rank roles are ordered lowest to highest; choose only the highest held rank.
    for (let index = RANK_PREFIXES.length - 1; index >= 0; index--) {
        const [roleId, prefix] = RANK_PREFIXES[index];
        if (member.roles.cache.has(roleId)) return prefix;
    }

    return '';
}


export async function handleNicknameChangeButton(interaction) {
    const modal = new ModalBuilder()
        .setCustomId('barracks_nickname_modal')
        .setTitle('Change Server Nickname');
    const nicknameInput = new TextInputBuilder()
        .setCustomId('nickname')
        .setLabel('Enter your display name')
        .setPlaceholder('Your display name (role prefix is added automatically)')
        .setStyle(TextInputStyle.Short)
        .setMinLength(1)
        .setMaxLength(32)
        .setRequired(true);
    modal.addComponents(new ActionRowBuilder().addComponents(nicknameInput));
    await interaction.showModal(modal);
}

export async function handleNicknameChangeModal(interaction, client) {
    const requestedNickname = interaction.fields.getTextInputValue('nickname').trim();
    if (!requestedNickname) {
        await interaction.reply({ content: 'Please enter a display name.', flags: [MessageFlags.Ephemeral] });
        return;
    }
    const guild = interaction.guild;
    if (!guild) {
        await interaction.reply({ content: 'This action can only be used in a server.', flags: [MessageFlags.Ephemeral] });
        return;
    }
    const member = await guild.members.fetch(interaction.user.id);
    if (!member.manageable) {
        await interaction.reply({ content: 'I cannot change your nickname. Please make sure my role is above your highest role.', flags: [MessageFlags.Ephemeral] });
        return;
    }
    const prefix = await getNicknamePrefix(member, client, guild.id);
    const newNickname = `${prefix}${requestedNickname}`;
    if (newNickname.length > 32) {
        const maxNameLength = Math.max(0, 32 - prefix.length);
        await interaction.reply({ content: `Your role prefix leaves room for only ${maxNameLength} more characters. Please shorten your display name.`, flags: [MessageFlags.Ephemeral] });
        return;
    }
    const userData = await getEconomyData(client, guild.id, interaction.user.id);
    if (!userData || userData.wallet < NICKNAME_CHANGE_PRICE) {
        const balance = Number(userData?.wallet) || 0;
        await interaction.reply({ content: `❌ You need **₱${NICKNAME_CHANGE_PRICE.toLocaleString()} bCash**, but your wallet only has **₱${balance.toLocaleString()}**.`, flags: [MessageFlags.Ephemeral] });
        return;
    }
    try {
        await member.setNickname(newNickname, 'Purchased nickname change with bCash');
    } catch (error) {
        await interaction.reply({ content: '❌ Discord could not update your nickname. No bCash was deducted.', flags: [MessageFlags.Ephemeral] });
        return;
    }
    userData.wallet -= NICKNAME_CHANGE_PRICE;
    const saved = await setEconomyData(client, guild.id, interaction.user.id, userData);
    if (!saved) {
        await interaction.reply({ content: 'Your nickname was changed, but the payment could not be saved. Please contact a server administrator.', flags: [MessageFlags.Ephemeral] });
        return;
    }
    await interaction.reply({
        content: `✅ Your server nickname has been changed to **${newNickname}**.\n💸 **Amount Paid:** ₱${NICKNAME_CHANGE_PRICE.toLocaleString()} bCash\n💰 **Remaining Balance:** ₱${userData.wallet.toLocaleString()}`,
        flags: [MessageFlags.Ephemeral],
    });
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
                'Want a new identity in the Barracks?\n' +
                'Change your server nickname using bCash.\n\n' +
                '**Service Price**\n' +
                '💰 **₱300,000 bCash**\n\n' +
                'Click the button below to enter your new nickname. Your bCash will only be charged if the nickname is changed successfully.'
            )
            .setImage('https://cdn.discordapp.com/attachments/1137703586730618961/1572694900573474886/Nick_pic.png?ex=6aff4dc3&is=6afdfc43&hm=bcf7775c1dd33331ee21bded44ef9ff1afa24643f807e3a6138bc07096ecae80')
            .setFooter({ text: 'Barracks • Nickname Services' });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('barracks_nickname_change')
                .setLabel('Change Nickname')
                .setEmoji('✏️')
                .setStyle(ButtonStyle.Primary)
        );

        await interaction.channel.send({ embeds: [embed], components: [row] });
    },
};
