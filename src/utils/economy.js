// economy.js

import { getColor, getEconomyKey as getEconomyStorageKey } from './database.js';
import { BotConfig } from '../config/bot.js';
import { normalizeEconomyData } from './schemas.js';
import { logger } from './logger.js';
import { validateDiscordId, validateNumber } from './validation.js';
import { DEFAULT_ECONOMY_DATA } from './constants.js';
import { createError, ErrorTypes, wrapServiceBoundary } from './errorHandler.js';
import { getUserLevelKey } from './database/keys.js';

const ECONOMY_CONFIG = BotConfig.economy || {};
const BASE_BANK_CAPACITY = ECONOMY_CONFIG.baseBankCapacity || 10000;
const BANK_CAPACITY_PER_LEVEL = ECONOMY_CONFIG.bankCapacityPerLevel || 5000;
const DAILY_AMOUNT = ECONOMY_CONFIG.dailyAmount || 100;
const WORK_MIN = ECONOMY_CONFIG.workMin || 10;
const WORK_MAX = ECONOMY_CONFIG.workMax || 100;
const COOLDOWNS = ECONOMY_CONFIG.cooldowns || {
daily: 24 * 60 * 60 * 1000,
work: 60 * 60 * 1000,
crime: 2 * 60 * 60 * 1000,
rob: 4 * 60 * 60 * 1000,
};

export function getEconomyKey(guildId, userId) {
    const validGuildId = validateDiscordId(guildId, 'guildId');
    const validUserId = validateDiscordId(userId, 'userId');
    
    if (!validGuildId || !validUserId) {
        throw new Error('Invalid guild ID or user ID');
    }
    
    return getEconomyStorageKey(validGuildId, validUserId);
}

export function getMaxBankCapacity(userData) {
    if (!userData) return BASE_BANK_CAPACITY;

    // Barracks rank capacity is based on the member's current leveling rank.
    // The leveling system awards the matching role at these same thresholds.
    const rankBankCapacities = ECONOMY_CONFIG.rankBankCapacities || {};
    const memberLevel = Math.max(0, Number(userData.level) || 0);
    const eligibleRanks = Object.keys(rankBankCapacities)
        .map(Number)
        .filter((level) => Number.isFinite(level) && level <= memberLevel)
        .sort((a, b) => b - a);
    const rankCapacity = eligibleRanks.length > 0
        ? Number(rankBankCapacities[eligibleRanks[0]])
        : BASE_BANK_CAPACITY;

    const bankLevel = userData.bankLevel || 0;
    const purchasedCapacity = Math.max(0, Number(userData.bankUpgradeCapacity) || 0);
    let capacity = Number.isFinite(rankCapacity) && rankCapacity > 0
        ? rankCapacity + (bankLevel * BANK_CAPACITY_PER_LEVEL) + purchasedCapacity
        : BASE_BANK_CAPACITY + (bankLevel * BANK_CAPACITY_PER_LEVEL) + purchasedCapacity;

    const upgrades = userData.upgrades || {};
    const inventory = userData.inventory || {};

    if (upgrades['bank_upgrade_1']) {
        capacity = Math.floor(capacity * 1.5);
    }

    const bankNotes = inventory['bank_note'] || 0;
    capacity += (bankNotes * 10000);

    const configuredMax = Number(ECONOMY_CONFIG.maxBankCapacity);
    if (Number.isFinite(configuredMax) && configuredMax > 0) {
        capacity = Math.min(capacity, configuredMax);
    }
    
    return capacity;
}

export function formatCurrency(amount) {
    const currencyName = ECONOMY_CONFIG.currency?.name || 'coins';
    return `${amount.toLocaleString()} ${currencyName}`;
}

export async function getEconomyData(client, guildId, userId) {
    try {
        if (!client.db || typeof client.db.get !== 'function') {
            throw new Error('Database not available');
        }

        const key = getEconomyKey(guildId, userId);
        let data = await client.db.get(key, null);

        // Migrate and combine this user's old guild-scoped accounts on first access.
        if (!data && typeof client.db.list === 'function') {
            const keys = await client.db.list('guild:');
            const legacyKeys = (Array.isArray(keys) ? keys : Object.keys(keys || {}))
                .filter((legacyKey) => /^guild:[^:]+:economy:\d+$/.test(legacyKey) &&
                    legacyKey.endsWith(`:${userId}`));

            if (legacyKeys.length > 0) {
                const legacyAccounts = await Promise.all(
                    legacyKeys.map(async (legacyKey) => client.db.get(legacyKey, null)),
                );
                const validAccounts = legacyAccounts.filter(
                    (account) => account && typeof account === 'object' && !Array.isArray(account),
                );

                if (validAccounts.length > 0) {
                    const merged = { ...DEFAULT_ECONOMY_DATA, ...validAccounts[0] };
                    merged.wallet = validAccounts.reduce((sum, account) => sum + (Number(account.wallet) || 0), 0);
                    merged.bank = validAccounts.reduce((sum, account) => sum + (Number(account.bank) || 0), 0);
                    merged.level = Math.max(...validAccounts.map((account) => Number(account.level) || 1));
                    merged.bankLevel = Math.max(...validAccounts.map((account) => Number(account.bankLevel) || 0));
                    merged.xp = Math.max(...validAccounts.map((account) => Number(account.xp) || 0));
                    merged.inventory = {};
                    merged.cooldowns = {};

                    for (const account of validAccounts) {
                        for (const [item, value] of Object.entries(account.inventory || {})) {
                            if (item === 'roleRewardClaims' && value && typeof value === 'object') {
                                merged.inventory.roleRewardClaims = {
                                    ...(merged.inventory.roleRewardClaims || {}),
                                    ...value,
                                };
                            } else if (typeof value === 'number') {
                                merged.inventory[item] = (merged.inventory[item] || 0) + value;
                            } else if (merged.inventory[item] === undefined) {
                                merged.inventory[item] = value;
                            }
                        }
                        for (const [cooldown, timestamp] of Object.entries(account.cooldowns || {})) {
                            merged.cooldowns[cooldown] = Math.max(merged.cooldowns[cooldown] || 0, Number(timestamp) || 0);
                        }
                        for (const field of ['lastDaily', 'lastWeekly', 'lastWork', 'lastCrime', 'lastRob', 'lastDeposit', 'lastWithdraw']) {
                            merged[field] = Math.max(Number(merged[field]) || 0, Number(account[field]) || 0);
                        }
                    }

                    data = normalizeEconomyData(merged, DEFAULT_ECONOMY_DATA);
                    await client.db.set(key, data);
                    logger.info(`[ECONOMY_GLOBAL] Migrated ${legacyKeys.length} guild account(s) for user ${userId} into the shared account.`);
                }
            }
        }

        const defaults = {
            ...DEFAULT_ECONOMY_DATA,
            wallet: ECONOMY_CONFIG.startingBalance ?? DEFAULT_ECONOMY_DATA.wallet,
        };

        const normalized = normalizeEconomyData(data || {}, defaults);

        // Leveling data is stored separately from economy data. Use the
        // leveling system's authoritative level so rank-based bank limits
        // match the member's actual Barracks level roles.
        const levelKey = getUserLevelKey(guildId, userId);
        const levelingData = await client.db.get(levelKey, null);
        if (levelingData && Number.isFinite(Number(levelingData.level))) {
            normalized.level = Math.max(0, Number(levelingData.level));
        }

        return normalized;
    } catch (error) {
        logger.error(`Error getting economy data for user ${userId}`, error);
        return normalizeEconomyData({}, DEFAULT_ECONOMY_DATA);
    }
}

export async function setEconomyData(client, guildId, userId, data) {
    try {
        if (!client.db || typeof client.db.set !== 'function') {
            throw new Error('Database not available');
        }

        const key = getEconomyKey(guildId, userId);
        const normalized = normalizeEconomyData(data, DEFAULT_ECONOMY_DATA);
        const saved = await client.db.set(key, normalized);
        return saved !== false;
    } catch (error) {
        logger.error(`Error saving economy data for user ${userId}`, error);
        return false;
    }
}

const economyFallbackLocks = new Map();

async function withEconomyFallbackLock(keys, callback) {
    const orderedKeys = [...keys].sort();
    const previous = orderedKeys.map((key) => economyFallbackLocks.get(key) || Promise.resolve());
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    for (const key of orderedKeys) economyFallbackLocks.set(key, gate);
    await Promise.all(previous);
    try {
        return await callback();
    } finally {
        release();
        for (const key of orderedKeys) {
            if (economyFallbackLocks.get(key) === gate) economyFallbackLocks.delete(key);
        }
    }
}

/**
 * Atomically reads, mutates, and persists one or more economy accounts.
 * PostgreSQL uses a database transaction; the in-memory fallback uses per-account
 * process locks because it is single-process and non-durable by design.
 * The callback must perform only local computation; external side effects belong after commit.
 */
export async function withEconomyTransaction(client, guildId, userIds, callback) {
    if (typeof callback !== 'function') throw new TypeError('Economy transaction callback is required.');
    if (!client?.db || typeof client.db.get !== 'function' || typeof client.db.set !== 'function') {
        throw new Error('Economy storage is unavailable; no balance was changed.');
    }

    const ids = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean).map(String))];
    if (!ids.length) throw new Error('At least one economy account is required.');
    const defaults = {
        ...DEFAULT_ECONOMY_DATA,
        wallet: ECONOMY_CONFIG.startingBalance ?? DEFAULT_ECONOMY_DATA.wallet,
    };

    // Preserve the existing first-access migration from legacy guild-scoped
    // economy keys before locking and mutating the canonical global account.
    await Promise.all(ids.map((userId) => getEconomyData(client, guildId, userId)));

    const levels = {};
    await Promise.all(ids.map(async (userId) => {
        const levelData = await client.db.get(getUserLevelKey(guildId, userId), null);
        levels[userId] = levelData && Number.isFinite(Number(levelData.level))
            ? Math.max(0, Number(levelData.level))
            : null;
    }));

    const usePostgresTransaction = typeof client.db.withKeyValueTransaction === 'function' &&
        !client.db.isDegraded?.() && !client.db.useFallback;
    if (!usePostgresTransaction) {
        const keys = ids.map((userId) => getEconomyKey(guildId, userId));
        return withEconomyFallbackLock(keys, async () => {
            const snapshots = new Map();
            const accounts = {};
            for (const userId of ids) {
                const key = getEconomyKey(guildId, userId);
                const raw = await client.db.get(key, null);
                snapshots.set(key, raw === null ? null : structuredClone(raw));
                const normalized = normalizeEconomyData(raw || {}, defaults);
                if (levels[userId] !== null) normalized.level = levels[userId];
                accounts[userId] = normalized;
            }
            const result = await callback(accounts);
            try {
                for (const userId of ids) {
                    const key = getEconomyKey(guildId, userId);
                    const saved = await client.db.set(key, normalizeEconomyData(accounts[userId], defaults));
                    if (saved === false) throw new Error(`Failed to save economy account for ${userId}.`);
                }
            } catch (error) {
                for (const [key, snapshot] of snapshots) {
                    if (snapshot === null) await client.db.delete?.(key);
                    else await client.db.set(key, snapshot);
                }
                throw error;
            }
            return result;
        });
    }

    return client.db.withKeyValueTransaction(async (transaction) => {
        const accounts = {};
        const orderedIds = [...ids].sort((a, b) => getEconomyKey(guildId, a).localeCompare(getEconomyKey(guildId, b)));
        for (const userId of orderedIds) {
            const key = getEconomyKey(guildId, userId);
            const raw = await transaction.get(key, null);
            const normalized = normalizeEconomyData(raw || {}, defaults);
            if (levels[userId] !== null) normalized.level = levels[userId];
            accounts[userId] = normalized;
        }

        const result = await callback(accounts);
        for (const userId of orderedIds) {
            const saved = await transaction.set(getEconomyKey(guildId, userId), normalizeEconomyData(accounts[userId], defaults));
            if (saved === false) throw new Error(`Failed to save economy account for ${userId}.`);
        }
        return result;
    });
}

/**
 * Reserve a wager once and record a durable pending receipt on the player's account.
 * The receipt makes later payout/refund settlement idempotent across retries.
 */
export async function startEconomyWager(client, guildId, userId, gameId, amount) {
    const wager = Number(amount);
    const receiptId = String(gameId || '').trim();
    if (!receiptId || !Number.isSafeInteger(wager) || wager <= 0) {
        throw new Error('A valid game ID and positive whole-number wager are required.');
    }

    return withEconomyTransaction(client, guildId, userId, async (accounts) => {
        const account = accounts[String(userId)];
        account.economyGameTransactions ||= {};
        const existing = account.economyGameTransactions[receiptId];
        if (existing) {
            if (String(existing.guildId || '') !== String(guildId)) {
                throw new Error('Game receipt ID is already used by another server.');
            }
            if (existing.amount !== wager) throw new Error('Game receipt already exists with a different wager.');
            return { started: false, status: existing.status, wallet: Number(account.wallet) || 0 };
        }
        const wallet = Math.max(0, Number(account.wallet) || 0);
        if (wallet < wager) throw new Error('Insufficient bCash for this wager.');
        account.wallet = wallet - wager;
        account.economyGameTransactions[receiptId] = {
            amount: wager,
            payout: 0,
            status: 'pending',
            guildId: String(guildId),
            gameId: receiptId,
            createdAt: Date.now(),
        };
        return { started: true, status: 'pending', wallet: account.wallet };
    });
}

/**
 * Settle a previously reserved wager exactly once. payout is the total amount
 * returned to the wallet (0 for loss, bet for refund/tie, or winnings payout).
 */
export async function settleEconomyWager(client, guildId, userId, gameId, payout) {
    const receiptId = String(gameId || '').trim();
    const amount = Number(payout);
    if (!receiptId || !Number.isSafeInteger(amount) || amount < 0) {
        throw new Error('A valid game ID and non-negative whole-number payout are required.');
    }

    return withEconomyTransaction(client, guildId, userId, async (accounts) => {
        const account = accounts[String(userId)];
        account.economyGameTransactions ||= {};
        const receipt = account.economyGameTransactions[receiptId];
        if (!receipt || String(receipt.guildId || '') !== String(guildId)) {
            throw new Error('No reserved wager exists for this game in this server.');
        }
        if (receipt.status !== 'pending') {
            return { settled: false, status: receipt.status, wallet: Number(account.wallet) || 0, payout: receipt.payout };
        }
        account.wallet = (Number(account.wallet) || 0) + amount;
        receipt.status = 'settled';
        receipt.payout = amount;
        receipt.settledAt = Date.now();
        const entries = Object.entries(account.economyGameTransactions);
        if (entries.length > 200) {
            for (const [key, value] of entries.sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0)).slice(0, entries.length - 200)) {
                if (value.status === 'settled') delete account.economyGameTransactions[key];
            }
        }
        return { settled: true, wallet: account.wallet, payout: amount };
    });
}

/**
 * Lists unsettled game wagers for authorized staff recovery workflows.
 * The caller is responsible for checking staff permissions before exposing this data.
 */
function hasDurableWagerStorage(client) {
    const db = client?.db;
    return Boolean(
        db &&
        typeof db.withKeyValueTransaction === 'function' &&
        (typeof db.isAvailable !== 'function' || db.isAvailable()) &&
        !db.isDegraded?.() &&
        !db.useFallback
    );
}

export async function listPendingEconomyWagers(client, guildId, limit = 100) {
    const safeLimit = Math.min(500, Math.max(1, Math.floor(Number(limit) || 100)));
    if (!hasDurableWagerStorage(client)) return { status: 'storage_unavailable', wagers: [], total: 0 };
    const keys = typeof client?.db?.list === 'function'
        ? await client.db.list('global:economy:')
        : null;
    if (!Array.isArray(keys)) {
        return { status: 'listing_unavailable', wagers: [] };
    }

    const wagers = [];
    for (const key of keys) {
        const userId = String(key).replace(/^global:economy:/, '');
        if (!userId || key === userId) continue;
        const account = await client.db.get(key, null);
        for (const [gameId, receipt] of Object.entries(account?.economyGameTransactions || {})) {
            if (receipt?.status !== 'pending' || String(receipt.guildId || '') !== String(guildId)) continue;
            wagers.push({
                userId, gameId, amount: Number(receipt.amount) || 0,
                createdAt: Number(receipt.createdAt) || 0,
                game: String(receipt.game || 'Unknown game'),
            });
        }
    }
    wagers.sort((a, b) => a.createdAt - b.createdAt);
    return { status: 'ok', wagers: wagers.slice(0, safeLimit), total: wagers.length };
}

/**
 * Returns recent wager recoveries for one guild. Intended for staff-only audit views.
 */
export async function listRecentEconomyWagerRecoveries(client, guildId, limit = 10) {
    const safeLimit = Math.min(50, Math.max(1, Math.floor(Number(limit) || 10)));
    if (!hasDurableWagerStorage(client)) return { status: 'storage_unavailable', recoveries: [], total: 0 };
    const keys = typeof client?.db?.list === 'function'
        ? await client.db.list('global:economy:')
        : null;
    if (!Array.isArray(keys)) return { status: 'listing_unavailable', recoveries: [] };

    const recoveries = [];
    for (const key of keys) {
        const userId = String(key).replace(/^global:economy:/, '');
        if (!/^\d{17,20}$/.test(userId)) continue;
        const account = await client.db.get(key, null);
        const storedAudit = Array.isArray(account?.economyWagerRecoveryAudit)
            ? account.economyWagerRecoveryAudit
            : [];
        const seen = new Set();
        for (const entry of storedAudit) {
            if (String(entry.guildId || '') !== String(guildId)) continue;
            seen.add(String(entry.gameId));
            recoveries.push({ ...entry, userId });
        }
        // Legacy accounts without the independent audit array can still be read
        // from receipt metadata. Once the bounded audit exists, do not re-add
        // older receipt metadata that has intentionally aged out of the 100-entry log.
        if (!Array.isArray(account?.economyWagerRecoveryAudit)) {
            for (const [gameId, receipt] of Object.entries(account?.economyGameTransactions || {})) {
                const audit = receipt?.recovery;
                if (!audit || seen.has(String(gameId)) || String(receipt.guildId || '') !== String(guildId)) continue;
                recoveries.push({
                    userId, gameId, guildId: String(receipt.guildId),
                    amount: Number(receipt.amount) || 0,
                    action: String(audit.action || 'unknown'),
                    actorId: String(audit.actorId || ''),
                    reason: String(audit.reason || ''),
                    recoveredAt: Number(audit.recoveredAt) || Number(receipt.settledAt) || 0,
                    status: String(receipt.status || 'unknown'),
                });
            }
        }
    }
    recoveries.sort((a, b) => b.recoveredAt - a.recoveredAt);
    return { status: 'ok', recoveries: recoveries.slice(0, safeLimit), total: recoveries.length };
}

/**
 * Resolves an abandoned wager exactly once. Only a refund or a zero-payout
 * loss settlement is supported: staff must not guess a game result.
 */
export async function recoverEconomyWager(client, guildId, userId, gameId, options = {}) {
    const action = options.action;
    const actorId = String(options.actorId || '').trim();
    const reason = String(options.reason || '').trim().slice(0, 500);
    if (!actorId || !reason || !['refund', 'settle_loss'].includes(action)) {
        throw new Error('A staff actor, reason, and valid recovery action are required.');
    }
    if (!hasDurableWagerStorage(client)) {
        throw new Error('Durable economy storage is unavailable; wager recovery was not performed.');
    }

    return withEconomyTransaction(client, guildId, userId, async (accounts) => {
        const account = accounts[String(userId)];
        account.economyGameTransactions ||= {};
        const receipt = account.economyGameTransactions[String(gameId)];
        if (!receipt || String(receipt.guildId || '') !== String(guildId)) return { recovered: false, status: 'not_found' };
        if (receipt.status !== 'pending') return { recovered: false, status: 'already_resolved', statusNow: receipt.status };
        const amount = Number(receipt.amount);
        if (!Number.isSafeInteger(amount) || amount <= 0) {
            throw new Error('The wager receipt has an invalid reserved amount.');
        }

        if (action === 'refund') {
            account.wallet = (Number(account.wallet) || 0) + amount;
            receipt.payout = amount;
        } else {
            receipt.payout = 0;
        }
        receipt.status = action === 'refund' ? 'refunded' : 'settled';
        receipt.settledAt = Date.now();
        const recoveredAt = Date.now();
        receipt.recovery = { actorId, reason, action, recoveredAt };
        const previousAudit = Array.isArray(account.economyWagerRecoveryAudit)
            ? account.economyWagerRecoveryAudit
            : [];
        // Keep the newest 100 records in the persisted account independently of wager receipts.
        account.economyWagerRecoveryAudit = previousAudit.concat({
            gameId: String(gameId), guildId: String(guildId), amount,
            action, actorId, reason, recoveredAt, status: receipt.status,
        }).slice(-100);
        return {
            recovered: true, status: receipt.status,
            userId: String(userId), gameId: String(gameId),
            amount, wallet: Number(account.wallet) || 0,
        };
    });
}

export async function updateBalance(client, guildId, userId, options = {}) {
    return withEconomyTransaction(client, guildId, userId, async (accounts) => {
        const data = accounts[userId];
        if (options.wallet !== undefined) data.wallet = Math.max(0, (Number(data.wallet) || 0) + options.wallet);
        if (options.bank !== undefined) {
            const maxBank = getMaxBankCapacity(data);
            data.bank = Math.min(Math.max(0, (Number(data.bank) || 0) + options.bank), maxBank);
        }
        if (options.xp !== undefined) {
            data.xp = Math.max(0, (Number(data.xp) || 0) + options.xp);
            const xpNeeded = Math.floor(5 * Math.pow(data.level || 1, 2) + 50 * (data.level || 1) + 100);
            if (data.xp >= xpNeeded) {
                data.xp -= xpNeeded;
                data.level = (data.level || 1) + 1;
                data.leveledUp = true;
            }
        }
        return structuredClone(data);
    });
}

export function checkCooldown(userData, action) {
    const cooldownTime = COOLDOWNS[action] || 0;
    const lastUsed = userData[`last${action.charAt(0).toUpperCase() + action.slice(1)}`] || 0;
    const now = Date.now();
    const remaining = Math.max(0, (lastUsed + cooldownTime) - now);
    
    return {
        onCooldown: remaining > 0,
        remaining,
        formatted: formatCooldown(remaining)
    };
}

function formatCooldown(ms) {
    if (ms < 1000) return 'now';
    
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}

export function getWorkReward() {
    const amount = Math.floor(Math.random() * (WORK_MAX - WORK_MIN + 1)) + WORK_MIN;
    const jobs = [
        'worked at a fast food restaurant',
        'worked as a programmer',
        'worked as a construction worker',
        'worked as a doctor',
        'worked as a streamer',
        'worked as a YouTuber',
        'worked as a teacher',
        'worked as a cashier',
        'worked as a delivery driver',
        'worked as a freelancer'
    ];
    
    const job = jobs[Math.floor(Math.random() * jobs.length)];
    
    return {
        amount,
        job,
        message: `You ${job} and earned ${formatCurrency(amount)}!`
    };
}

export function getCrimeOutcome() {
    const outcomes = [
        {
            success: true,
            amount: Math.floor(Math.random() * 200) + 50,
            message: 'You successfully robbed a bank and got away with {amount}!' 
        },
        {
            success: true,
            amount: Math.floor(Math.random() * 100) + 20,
            message: 'You pickpocketed someone and stole {amount}!' 
        },
        {
            success: true,
            amount: Math.floor(Math.random() * 150) + 30,
            message: 'You hacked into a bank account and transferred {amount} to yourself!' 
        },
        {
            success: false,
            fine: Math.floor(Math.random() * 100) + 50,
            message: 'You got caught and had to pay a fine of {fine}!' 
        },
        {
            success: false,
            fine: Math.floor(Math.random() * 150) + 50,
            message: 'The police caught you! You paid {fine} to get out of jail.' 
        },
        {
            success: false,
            fine: 0,
            message: 'Your attempt failed, but you managed to escape!' 
        }
    ];
    
    return outcomes[Math.floor(Math.random() * outcomes.length)];
}

export function getRobOutcome(targetBalance) {
    if (targetBalance <= 0) {
        return {
            success: false,
            amount: 0,
            message: 'The target has no money to steal!'
        };
    }
    
const success = Math.random() > 0.4;
    
    if (success) {
        const amount = Math.min(
Math.floor(Math.random() * (targetBalance * 0.3)) + 1,
            targetBalance
        );
        
        return {
            success: true,
            amount,
            message: `You successfully robbed them and got away with {amount}!`
        };
    } else {
        const fine = Math.floor(Math.random() * 200) + 100;
        
        return {
            success: false,
            amount: 0,
            fine,
            message: `You got caught! You had to pay a fine of {fine}.`
        };
    }
}

export function formatShopItem(item, index) {
    return `**${index + 1}.** ${item.emoji} **${item.name}** - ${formatCurrency(item.price)}\n${item.description}\n`;
}

export const addMoney = wrapServiceBoundary(async function addMoney(client, guildId, userId, amount, type = 'wallet') {
    const validAmount = validateNumber(amount, 'amount');
    if (validAmount === null || validAmount <= 0) {
        throw createError('Invalid amount', ErrorTypes.VALIDATION, 'Amount must be a positive number.', { guildId, userId, amount, operation: 'addMoney' });
    }
    if (type !== 'wallet' && type !== 'bank') {
        throw createError('Invalid money type', ErrorTypes.VALIDATION, 'Type must be "wallet" or "bank".', { guildId, userId, type, operation: 'addMoney' });
    }

    return withEconomyTransaction(client, guildId, userId, async (accounts) => {
        const userData = accounts[userId];
        if (type === 'bank') {
            const maxBank = getMaxBankCapacity(userData);
            if ((userData.bank || 0) + validAmount > maxBank) {
                throw createError('Bank capacity exceeded', ErrorTypes.VALIDATION,
                    `Bank capacity exceeded. Current: ${userData.bank || 0}, Max: ${maxBank}.`,
                    { guildId, userId, current: userData.bank || 0, max: maxBank, operation: 'addMoney' });
            }
            userData.bank = (userData.bank || 0) + validAmount;
        } else {
            userData.wallet = (userData.wallet || 0) + validAmount;
        }
        return {
            newBalance: type === 'bank' ? userData.bank : userData.wallet,
            ...(type === 'bank' ? { maxBank: getMaxBankCapacity(userData) } : {}),
        };
    });
}, {
    service: 'economy',
    operation: 'addMoney',
    userMessage: 'Failed to add money. Please try again.',
});

export const removeMoney = wrapServiceBoundary(async function removeMoney(client, guildId, userId, amount, type = 'wallet') {
    const validAmount = validateNumber(amount, 'amount');
    if (validAmount === null || validAmount <= 0) {
        throw createError('Invalid amount', ErrorTypes.VALIDATION, 'Amount must be a positive number.', { guildId, userId, amount, operation: 'removeMoney' });
    }
    if (type !== 'wallet' && type !== 'bank') {
        throw createError('Invalid money type', ErrorTypes.VALIDATION, 'Type must be "wallet" or "bank".', { guildId, userId, type, operation: 'removeMoney' });
    }

    return withEconomyTransaction(client, guildId, userId, async (accounts) => {
        const userData = accounts[userId];
        const current = Number(userData[type]) || 0;
        if (current < validAmount) {
            const label = type === 'bank' ? 'bank' : 'wallet';
            throw createError(
                type === 'bank' ? 'Insufficient bank funds' : 'Insufficient wallet funds',
                ErrorTypes.VALIDATION,
                `Insufficient funds in ${label}. You have ${current}, need ${validAmount}.`,
                { guildId, userId, current, required: validAmount, operation: 'removeMoney' }
            );
        }
        userData[type] = current - validAmount;
        return { newBalance: userData[type] };
    });
}, {
    service: 'economy',
    operation: 'removeMoney',
    userMessage: 'Failed to remove money. Please try again.',
});

export function getShopInventory() {
    return [
        {
            id: 'fishing_rod',
            name: 'Fishing Rod',
            emoji: '🎣',
            price: 500,
            description: 'Catch fish to sell for profit!',
            type: 'tool'
        },
        {
            id: 'hunting_rifle',
            name: 'Hunting Rifle',
            emoji: '🔫',
            price: 1000,
            description: 'Hunt animals for meat and fur!',
            type: 'tool'
        },
        {
            id: 'laptop',
            name: 'Laptop',
            emoji: '💻',
            price: 2000,
            description: 'Work as a programmer for higher pay!',
            type: 'tool',
            workMultiplier: 1.5
        },
        {
            id: 'bank_loan',
            name: 'Bank Loan',
            emoji: '🏦',
            price: 5000,
            description: 'Increases your bank capacity by 50,000!',
            type: 'upgrade',
            effect: 'bank_capacity',
            value: 50000
        },
        {
            id: 'lottery_ticket',
            name: 'Lottery Ticket',
            emoji: '🎫',
            price: 100,
            description: 'A chance to win big!',
            type: 'consumable',
            use: 'gamble'
        }
    ];
}