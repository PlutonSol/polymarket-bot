require('dotenv').config();

const CONFIG = {
    // Polymarket CLOB
    CLOB_HOST: 'https://clob.polymarket.com',
    GAMMA_HOST: 'https://gamma-api.polymarket.com',
    DATA_HOST: 'https://data-api.polymarket.com',
    CHAIN_ID: 137, // Polygon

    // Wallet
    PRIVATE_KEY: process.env.PRIVATE_KEY || '',
    WALLET_ADDRESS: process.env.WALLET_ADDRESS || '',
    POLY_API_KEY: process.env.POLY_API_KEY || '',
    POLY_API_SECRET: process.env.POLY_API_SECRET || '',
    POLY_API_PASSPHRASE: process.env.POLY_API_PASSPHRASE || '',

    // LLM
    LLM_PROVIDER: process.env.LLM_PROVIDER || 'openai',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
    LLM_MODEL: process.env.LLM_MODEL || 'gpt-4o',

    // Telegram
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',

    // Trading
    DAILY_VOLUME_TARGET: parseFloat(process.env.DAILY_VOLUME_TARGET || '1000'),
    MAX_TRADE_SIZE: parseFloat(process.env.MAX_TRADE_SIZE || '50'),
    MIN_TRADE_SIZE: parseFloat(process.env.MIN_TRADE_SIZE || '5'),
    MAX_OPEN_POSITIONS: parseInt(process.env.MAX_OPEN_POSITIONS || '10'),
    TRADING_INTERVAL: parseInt(process.env.TRADING_INTERVAL || '60') * 1000,
    MAX_SPREAD: parseFloat(process.env.MAX_SPREAD || '5'),
    DRY_RUN: process.env.DRY_RUN !== 'false',
};

function validateConfig() {
    const errors = [];
    if (!CONFIG.DRY_RUN) {
        if (!CONFIG.PRIVATE_KEY) errors.push('PRIVATE_KEY requis pour le trading live');
        if (!CONFIG.WALLET_ADDRESS) errors.push('WALLET_ADDRESS requis');
    }
    if (!CONFIG.OPENAI_API_KEY && !CONFIG.ANTHROPIC_API_KEY) {
        errors.push('OPENAI_API_KEY ou ANTHROPIC_API_KEY requis');
    }
    if (!CONFIG.TELEGRAM_BOT_TOKEN) errors.push('TELEGRAM_BOT_TOKEN requis');
    if (!CONFIG.TELEGRAM_CHAT_ID) errors.push('TELEGRAM_CHAT_ID requis');
    return errors;
}

module.exports = { CONFIG, validateConfig };
