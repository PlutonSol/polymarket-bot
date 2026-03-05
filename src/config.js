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

    // Scalping parameters
    MIN_MARKET_VOLUME: parseFloat(process.env.MIN_MARKET_VOLUME || '1000000'),  // 1M minimum
    SCALP_TICK: parseFloat(process.env.SCALP_TICK || '0.01'),                   // +0.01 revente (1 tick = 1 cent)
    TRADE_SIZE_USD: parseFloat(process.env.TRADE_SIZE_USD || '50'),              // Taille par scalp en USD (fallback si pas de balance)
    MAX_TRADE_SIZE: parseFloat(process.env.MAX_TRADE_SIZE || '200'),             // Taille max par scalp
    MIN_TRADE_SIZE: parseFloat(process.env.MIN_TRADE_SIZE || '5'),               // Taille min par scalp
    MAX_WALLET_EXPOSURE: parseFloat(process.env.MAX_WALLET_EXPOSURE || '0.20'),  // Max 20% du wallet par trade
    DAILY_VOLUME_TARGET: parseFloat(process.env.DAILY_VOLUME_TARGET || '5000'),  // Volume cible/jour
    SCALP_INTERVAL: parseInt(process.env.SCALP_INTERVAL || '10') * 1000,         // Intervalle entre scalps (10s)
    MAX_CONCURRENT_SCALPS: parseInt(process.env.MAX_CONCURRENT_SCALPS || '3'),   // Scalps simultanés max
    SCALP_TIMEOUT: parseInt(process.env.SCALP_TIMEOUT || '60') * 1000,           // Timeout pour sell après buy (60s)
    MAX_SPREAD_CENTS: parseFloat(process.env.MAX_SPREAD_CENTS || '0.2'),         // Spread max 0.2 cents (marchés ultra-liquides)
    MIN_BOOK_DEPTH_USD: parseFloat(process.env.MIN_BOOK_DEPTH_USD || '500'),     // Liquidité min dans le book

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
    if (CONFIG.MAX_WALLET_EXPOSURE > 1 || CONFIG.MAX_WALLET_EXPOSURE <= 0) {
        errors.push('MAX_WALLET_EXPOSURE doit être entre 0 et 1 (ex: 0.20 = 20%)');
    }
    if (CONFIG.SCALP_TICK <= 0 || CONFIG.SCALP_TICK > 0.1) {
        errors.push('SCALP_TICK doit être entre 0.001 et 0.1');
    }
    return errors;
}

module.exports = { CONFIG, validateConfig };
