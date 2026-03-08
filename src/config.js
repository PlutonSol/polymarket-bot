require('dotenv').config();

const CONFIG = {
    // Polymarket CLOB
    CLOB_HOST: 'https://clob.polymarket.com',
    GAMMA_HOST: 'https://gamma-api.polymarket.com',
    DATA_HOST: 'https://data-api.polymarket.com',
    CHAIN_ID: 137, // Polygon

    // Wallet (PRIVATE_KEY chargée séparément pour éviter exposition en mémoire)
    WALLET_ADDRESS: process.env.WALLET_ADDRESS || '',
    PROXY_WALLET_ADDRESS: process.env.PROXY_WALLET_ADDRESS || '',
    POLY_API_KEY: process.env.POLY_API_KEY || '',
    POLY_API_SECRET: process.env.POLY_API_SECRET || '',
    POLY_API_PASSPHRASE: process.env.POLY_API_PASSPHRASE || '',

    // Telegram
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
    TELEGRAM_USER_ID: process.env.TELEGRAM_USER_ID || '', // ID utilisateur Telegram pour auth renforcée

    // Scalping parameters
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
    MAX_DAILY_LOSS: parseFloat(process.env.MAX_DAILY_LOSS || '50'),              // Stop-loss journalier en USD

    DRY_RUN: process.env.DRY_RUN !== 'false',
};

/**
 * Charge la private key de façon sécurisée.
 * À appeler une seule fois à l'init, ne pas stocker le résultat.
 */
function getPrivateKey() {
    const pk = process.env.PRIVATE_KEY || '';
    if (pk === '0xYOUR_PRIVATE_KEY_HERE' || pk === '') {
        return null;
    }
    return pk;
}

/**
 * Efface la private key de l'environnement après usage.
 */
function clearPrivateKey() {
    delete process.env.PRIVATE_KEY;
}

function validateConfig() {
    const errors = [];
    if (!CONFIG.DRY_RUN) {
        const pk = getPrivateKey();
        if (!pk) errors.push('PRIVATE_KEY requis pour le trading live (ne pas utiliser le placeholder)');
        if (!CONFIG.WALLET_ADDRESS && !CONFIG.PROXY_WALLET_ADDRESS) {
            errors.push('PROXY_WALLET_ADDRESS (ou WALLET_ADDRESS) requis - c\'est l\'adresse du proxy wallet Polymarket où sont vos fonds');
        }
    }
    if (!CONFIG.TELEGRAM_BOT_TOKEN) errors.push('TELEGRAM_BOT_TOKEN requis');
    if (!CONFIG.TELEGRAM_CHAT_ID) errors.push('TELEGRAM_CHAT_ID requis');
    if (CONFIG.MAX_WALLET_EXPOSURE > 1 || CONFIG.MAX_WALLET_EXPOSURE <= 0) {
        errors.push('MAX_WALLET_EXPOSURE doit être entre 0 et 1 (ex: 0.20 = 20%)');
    }
    if (CONFIG.SCALP_TICK <= 0 || CONFIG.SCALP_TICK > 0.1) {
        errors.push('SCALP_TICK doit être entre 0.001 et 0.1');
    }
    // Valider que les valeurs numériques sont finies et raisonnables
    const numericChecks = [
        ['TRADE_SIZE_USD', 1, 100000],
        ['MAX_TRADE_SIZE', 1, 100000],
        ['MIN_TRADE_SIZE', 0.1, 100000],
        ['DAILY_VOLUME_TARGET', 1, 1e9],
        ['MAX_SPREAD_CENTS', 0.01, 100],
        ['MIN_BOOK_DEPTH_USD', 0, 1e9],
    ];
    for (const [key, min, max] of numericChecks) {
        const val = CONFIG[key];
        if (!Number.isFinite(val) || val < min || val > max) {
            errors.push(`${key}=${val} invalide (doit être entre ${min} et ${max})`);
        }
    }
    return errors;
}

module.exports = { CONFIG, validateConfig, getPrivateKey, clearPrivateKey };
