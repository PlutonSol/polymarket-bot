require('dotenv').config();

const CONFIG = {
    // =============================================
    // HYPERLIQUID
    // =============================================
    HYPERLIQUID_API: 'https://api.hyperliquid.xyz',
    HYPERL_EVM_RPC: process.env.HYPERL_EVM_RPC || 'https://rpc.hyperliquid.xyz',

    // Wallet privée pour exécuter les trades
    PRIVATE_KEY: process.env.PRIVATE_KEY || '',
    // Adresse du wallet (dérivée de la clé privée au démarrage)
    WALLET_ADDRESS: process.env.WALLET_ADDRESS || '',

    // =============================================
    // DEX sur HyperEVM (UniswapV2-like)
    // =============================================
    // Router principal (ex: HyperSwap, KittenSwap, etc.)
    DEX_ROUTER_ADDRESS: process.env.DEX_ROUTER_ADDRESS || '',
    DEX_FACTORY_ADDRESS: process.env.DEX_FACTORY_ADDRESS || '',

    // =============================================
    // TOKENS À SURVEILLER
    // Paires token/USDC à arbitrer
    // Format: { symbol, hyperliquidName, evmAddress, decimals }
    // =============================================
    WHYPE_ADDRESS: process.env.WHYPE_ADDRESS || '0x5555555555555555555555555555555555555555',
    USDC_ADDRESS: process.env.USDC_ADDRESS || '0x0d01DC56dcAd1A5F2b34b58e1BeC6a328d9e43E8',

    TOKENS: [
        {
            symbol: 'HYPE',
            hyperliquidName: 'HYPE',
            evmAddress: process.env.WHYPE_ADDRESS || '0x5555555555555555555555555555555555555555',
            decimals: 18,
        },
        // Ajouter d'autres tokens ici
        // {
        //     symbol: 'PURR',
        //     hyperliquidName: 'PURR',
        //     evmAddress: '0x...',
        //     decimals: 18,
        // },
    ],

    // =============================================
    // ARBITRAGE PARAMS
    // =============================================
    // Spread minimum pour trigger un arbitrage (en %)
    MIN_SPREAD_PCT: parseFloat(process.env.MIN_SPREAD_PCT || '0.5'),
    // Montant par trade en USDC
    TRADE_SIZE_USDC: parseFloat(process.env.TRADE_SIZE_USDC || '100'),
    // Montant max par trade
    MAX_TRADE_SIZE_USDC: parseFloat(process.env.MAX_TRADE_SIZE_USDC || '1000'),
    // Slippage max toléré (en %)
    MAX_SLIPPAGE_PCT: parseFloat(process.env.MAX_SLIPPAGE_PCT || '0.3'),
    // Intervalle de scan (ms)
    SCAN_INTERVAL_MS: parseInt(process.env.SCAN_INTERVAL_MS || '3000'),
    // Gas price max (gwei)
    MAX_GAS_PRICE_GWEI: parseFloat(process.env.MAX_GAS_PRICE_GWEI || '50'),
    // Mode dry-run (pas de trades réels)
    DRY_RUN: process.env.DRY_RUN !== 'false',

    // =============================================
    // TELEGRAM
    // =============================================
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',

    // =============================================
    // LOGGING
    // =============================================
    LOG_LEVEL: process.env.LOG_LEVEL || 'info', // debug, info, warn, error
};

module.exports = CONFIG;
