require('dotenv').config();

// Adresses fixes du réseau HyperEVM
const WHYPE_ADDRESS = '0x5555555555555555555555555555555555555555';
const USDC_ADDRESS = process.env.USDC_ADDRESS || '0x0d01DC56dcAd1A5F2b34b58e1BeC6a328d9e43E8';

const CONFIG = {
    // =============================================
    // HYPERLIQUID
    // =============================================
    HYPERLIQUID_API: 'https://api.hyperliquid.xyz',
    HYPERL_EVM_RPC: process.env.HYPERL_EVM_RPC || 'https://rpc.hyperliquid.xyz',

    // Wallet
    PRIVATE_KEY: process.env.PRIVATE_KEY || '',
    WALLET_ADDRESS: process.env.WALLET_ADDRESS || '',

    // =============================================
    // DEX sur HyperEVM (UniswapV2-like)
    // =============================================
    DEX_ROUTER_ADDRESS: process.env.DEX_ROUTER_ADDRESS || '',
    DEX_FACTORY_ADDRESS: process.env.DEX_FACTORY_ADDRESS || '',

    // =============================================
    // HYPE UNIQUEMENT
    // =============================================
    WHYPE_ADDRESS,
    USDC_ADDRESS,

    // Token unique: HYPE
    HYPE_TOKEN: {
        symbol: 'HYPE',
        hyperliquidName: 'HYPE',
        evmAddress: WHYPE_ADDRESS,
        decimals: 18,
    },

    // =============================================
    // ARBITRAGE PARAMS
    // =============================================
    MIN_SPREAD_PCT: parseFloat(process.env.MIN_SPREAD_PCT || '0.5'),
    TRADE_SIZE_USDC: parseFloat(process.env.TRADE_SIZE_USDC || '100'),
    MAX_TRADE_SIZE_USDC: parseFloat(process.env.MAX_TRADE_SIZE_USDC || '1000'),
    MAX_SLIPPAGE_PCT: parseFloat(process.env.MAX_SLIPPAGE_PCT || '0.3'),
    SCAN_INTERVAL_MS: parseInt(process.env.SCAN_INTERVAL_MS || '1000'),
    MAX_GAS_PRICE_GWEI: parseFloat(process.env.MAX_GAS_PRICE_GWEI || '50'),
    DRY_RUN: process.env.DRY_RUN !== 'false',

    // Sécurité
    MAX_LOSS_USD: parseFloat(process.env.MAX_LOSS_USD || '50'),
    MAX_TRADES_PER_HOUR: parseInt(process.env.MAX_TRADES_PER_HOUR || '20'),
    FETCH_TIMEOUT_MS: parseInt(process.env.FETCH_TIMEOUT_MS || '5000'),

    // =============================================
    // TELEGRAM
    // =============================================
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',

    // =============================================
    // LOGGING
    // =============================================
    LOG_LEVEL: process.env.LOG_LEVEL || 'info',
};

module.exports = CONFIG;
