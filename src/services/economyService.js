// economyService.js

import { logger } from '../utils/logger.js';
import { getEconomyData, setEconomyData, getMaxBankCapacity, withEconomyTransaction } from '../utils/economy.js';
import { createError, ErrorTypes } from '../utils/errorHandler.js';
import { wrapServiceClassMethods } from '../utils/serviceErrorBoundary.js';

class EconomyService {

  static DAILY_COOLDOWN = 24 * 60 * 60 * 1000;
  static WORK_COOLDOWN = 30 * 60 * 1000;
  static GAMBLE_COOLDOWN = 5 * 60 * 1000;
  static CRIME_COOLDOWN = 60 * 60 * 1000;
  static ROB_COOLDOWN = 4 * 60 * 60 * 1000;
  static MINE_COOLDOWN = 60 * 60 * 1000;
  static FISH_COOLDOWN = 45 * 60 * 1000;
  static BEG_COOLDOWN = 30 * 60 * 1000;
  
  static DAILY_AMOUNT = 1000;
  static MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

  static assertSafeBalance(value, context = {}) {
    if (!Number.isSafeInteger(value) || value < 0 || value > this.MAX_SAFE_INTEGER) {
      throw createError(
        "Invalid balance state",
        ErrorTypes.VALIDATION,
        "Operation would create an invalid account balance.",
        { value, ...context }
      );
    }
  }

  static async claimDaily(client, guildId, userId) {
    const now = Date.now();
    const result = await withEconomyTransaction(client, guildId, userId, async (accounts) => {
      const userData = accounts[userId];
      const remaining = (Number(userData.lastDaily) || 0) + this.DAILY_COOLDOWN - now;
      if (remaining > 0) {
        throw createError('Daily cooldown active', ErrorTypes.RATE_LIMIT,
          `You need to wait before claiming daily again. Try again in **${this.formatDuration(remaining)}**.`,
          { remaining, cooldownType: 'daily' });
      }
      const earned = this.DAILY_AMOUNT;
      const nextWallet = (Number(userData.wallet) || 0) + earned;
      this.assertSafeBalance(nextWallet, { operation: 'claimDaily', userId, guildId });
      userData.wallet = nextWallet;
      userData.lastDaily = now;
      return { earned, newWallet: nextWallet, nextClaimTime: new Date(now + this.DAILY_COOLDOWN) };
    });
    logger.info('[ECONOMY_TRANSACTION] Daily claimed atomically', { userId, guildId, ...result, timestamp: new Date().toISOString(), source: 'claim_daily' });
    return result;
  }

  static async transferMoney(client, guildId, senderId, receiverId, amount) {
    logger.debug('[ECONOMY_SERVICE] transferMoney requested', { senderId, receiverId, amount, guildId });
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw createError('Invalid transfer amount', ErrorTypes.VALIDATION, 'Amount must be a positive whole number.', { amount, senderId });
    }
    if (senderId === receiverId) {
      throw createError('Cannot pay self', ErrorTypes.VALIDATION, 'You cannot pay yourself.', { senderId, receiverId });
    }
    this.validateAmount(amount, { operation: 'transfer', senderId, receiverId });

    try {
      const result = await withEconomyTransaction(client, guildId, [senderId, receiverId], async (accounts) => {
        const senderData = accounts[senderId];
        const receiverData = accounts[receiverId];
        if ((Number(senderData.wallet) || 0) < amount) {
          throw createError(
            'Insufficient funds',
            ErrorTypes.VALIDATION,
            `You only have **₱${(Number(senderData.wallet) || 0).toLocaleString()}** in cash.`,
            { required: amount, available: senderData.wallet, senderId }
          );
        }
        const senderNext = (Number(senderData.wallet) || 0) - amount;
        const receiverNext = (Number(receiverData.wallet) || 0) + amount;
        this.assertSafeBalance(senderNext, { operation: 'transfer.sender', senderId, amount });
        this.assertSafeBalance(receiverNext, { operation: 'transfer.receiver', receiverId, amount });
        senderData.wallet = senderNext;
        receiverData.wallet = receiverNext;
        return { senderNewBalance: senderNext, receiverNewBalance: receiverNext };
      });

      logger.info('[ECONOMY_TRANSACTION] Money transferred atomically', {
        type: 'transfer', senderId, receiverId, guildId, amount,
        senderNewBalance: result.senderNewBalance,
        receiverNewBalance: result.receiverNewBalance,
        timestamp: new Date().toISOString(),
      });
      return result;
    } catch (error) {
      if (error?.type === ErrorTypes.VALIDATION || error?.name === 'ValidationError') throw error;
      logger.error('[ECONOMY_SERVICE] Atomic transfer failed; transaction rolled back.', error, { senderId, receiverId, amount, guildId });
      throw createError('Failed to save transfer', ErrorTypes.DATABASE, 'Failed to process transfer. Please try again.', { senderId, receiverId, amount });
    }
  }

  static async addMoney(client, guildId, userId, amount, source = 'unknown') {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw createError('Invalid amount', ErrorTypes.VALIDATION, 'Amount must be a positive whole number.', { amount, userId, source });
    this.validateAmount(amount, { operation: 'addMoney', userId, source });
    const result = await withEconomyTransaction(client, guildId, userId, async (accounts) => {
      const userData = accounts[userId];
      const balanceBefore = Number(userData.wallet) || 0;
      const nextWallet = balanceBefore + amount;
      this.assertSafeBalance(nextWallet, { operation: 'addMoney', userId, source, amount });
      userData.wallet = nextWallet;
      return { userData: structuredClone(userData), balanceBefore, balanceAfter: nextWallet };
    });
    logger.info('[ECONOMY_TRANSACTION] Money added atomically', { userId, guildId, amount, source, balanceBefore: result.balanceBefore, balanceAfter: result.balanceAfter, delta: amount, timestamp: new Date().toISOString() });
    return result.userData;
  }

  static async removeMoney(client, guildId, userId, amount, reason = 'unknown') {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw createError('Invalid amount', ErrorTypes.VALIDATION, 'Amount must be a positive whole number.', { amount, userId, reason });
    this.validateAmount(amount, { operation: 'removeMoney', userId, reason });
    const result = await withEconomyTransaction(client, guildId, userId, async (accounts) => {
      const userData = accounts[userId];
      const balanceBefore = Number(userData.wallet) || 0;
      if (balanceBefore < amount) throw createError('Insufficient funds', ErrorTypes.VALIDATION, `You only have **₱${balanceBefore.toLocaleString()}**.`, { required: amount, available: balanceBefore, reason });
      userData.wallet = balanceBefore - amount;
      return { userData: structuredClone(userData), balanceBefore, balanceAfter: userData.wallet };
    });
    logger.info('[ECONOMY_TRANSACTION] Money removed atomically', { userId, guildId, amount, reason, balanceBefore: result.balanceBefore, balanceAfter: result.balanceAfter, delta: -amount, timestamp: new Date().toISOString() });
    return result.userData;
  }

  static async depositToBank(client, guildId, userId, amount) {
    this.validateAmount(amount, { operation: 'deposit', userId });
    return withEconomyTransaction(client, guildId, userId, async (accounts) => {
      const userData = accounts[userId];
      const wallet = Number(userData.wallet) || 0;
      const bank = Number(userData.bank) || 0;
      const maxBank = getMaxBankCapacity(userData);
      if (wallet < amount) throw createError('Insufficient cash', ErrorTypes.VALIDATION, `You only have **₱${wallet.toLocaleString()}** in cash.`, { required: amount, available: wallet });
      if (bank + amount > maxBank) throw createError('Bank capacity exceeded', ErrorTypes.VALIDATION, `Your bank can only hold **₱${maxBank.toLocaleString()}**. You would exceed capacity by **₱${(bank + amount - maxBank).toLocaleString()}**.`, { capacity: maxBank, current: bank, requested: amount });
      userData.wallet = wallet - amount;
      userData.bank = bank + amount;
      this.assertSafeBalance(userData.wallet, { operation: 'deposit.wallet', userId, amount });
      this.assertSafeBalance(userData.bank, { operation: 'deposit.bank', userId, amount });
      return structuredClone(userData);
    });
  }

  static async withdrawFromBank(client, guildId, userId, amount) {
    this.validateAmount(amount, { operation: 'withdraw', userId });
    return withEconomyTransaction(client, guildId, userId, async (accounts) => {
      const userData = accounts[userId];
      const bank = Number(userData.bank) || 0;
      if (bank < amount) throw createError('Insufficient bank balance', ErrorTypes.VALIDATION, `You only have **₱${bank.toLocaleString()}** in your bank.`, { required: amount, available: bank });
      const nextWallet = (Number(userData.wallet) || 0) + amount;
      const nextBank = bank - amount;
      this.assertSafeBalance(nextWallet, { operation: 'withdraw.wallet', userId, amount });
      this.assertSafeBalance(nextBank, { operation: 'withdraw.bank', userId, amount });
      userData.wallet = nextWallet;
      userData.bank = nextBank;
      return structuredClone(userData);
    });
  }

  static checkCooldown(userData, action, cooldownMs) {
    const lastActionField = `last${action.charAt(0).toUpperCase() + action.slice(1)}`;
    const lastTime = userData[lastActionField] || 0;
    const now = Date.now();
    const remaining = Math.max(0, lastTime + cooldownMs - now);

    return {
      isOnCooldown: remaining > 0,
      remaining,
      formatted: this.formatDuration(remaining),
      nextAvailable: new Date(lastTime + cooldownMs)
    };
  }

  static validateAmount(amount, context = {}) {
    if (!Number.isInteger(amount)) {
      throw createError(
        "Invalid amount - not an integer",
        ErrorTypes.VALIDATION,
        "Amount must be a whole number",
        context
      );
    }

    if (amount <= 0) {
      throw createError(
        "Invalid amount - not positive",
        ErrorTypes.VALIDATION,
        "Amount must be positive",
        context
      );
    }

    if (amount > this.MAX_SAFE_INTEGER) {
      logger.error(`[ECONOMY] Amount exceeds MAX_SAFE_INTEGER`, { amount, context });
      throw createError(
        "Amount too large",
        ErrorTypes.VALIDATION,
        "The amount is too large to process",
        context
      );
    }
  }

  static formatDuration(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m ${seconds}s`;
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
  }

  static formatCooldownDisplay(ms) {
    const duration = this.formatDuration(ms);
    return `**${duration}**`;
  }
}

wrapServiceClassMethods(EconomyService, (methodName) => ({
  service: 'EconomyService',
  operation: methodName,
  message: `Economy service operation failed: ${methodName}`,
  userMessage: 'An economy operation failed. Please try again in a moment.'
}));

export default EconomyService;