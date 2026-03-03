require('dotenv').config();
const CONFIG = require('./config');
const ArbitrageEngine = require('./arbitrage');
const TelegramNotifier = require('./telegram');

async function main() {
    console.log('==================================================');
    console.log('  Bot Arbitrage HYPE: Hyperliquid ↔ HyperEVM');
    console.log('==================================================\n');

    validateConfig();

    const telegram = new TelegramNotifier();
    const arbEngine = new ArbitrageEngine(telegram);
    telegram.init(arbEngine);

    await telegram.send(`🤖 *Bot Arbitrage HYPE*
Hyperliquid L1 ↔ HyperEVM DEX

⚙️ *Config:*
• Spread min: ${CONFIG.MIN_SPREAD_PCT}%
• Taille: $${CONFIG.TRADE_SIZE_USDC}
• Slippage max: ${CONFIG.MAX_SLIPPAGE_PCT}%
• Max loss: $${CONFIG.MAX_LOSS_USD}
• Mode: ${CONFIG.DRY_RUN ? '🧪 Dry Run' : '🔴 LIVE'}
• Trigger: block-aligned (2s blocks)

/start\\_arb pour démarrer`);

    if (process.env.AUTO_START === 'true') {
        console.log('[MAIN] Auto-starting...');
        arbEngine.start();
    }

    const shutdown = async (signal) => {
        console.log(`\n[MAIN] ${signal} received`);
        arbEngine.stop();
        const stats = arbEngine.getStats();
        await telegram.send(`🔴 *Bot arrêté* (${signal})

• Durée: ${stats.uptimeStr}
• Scans: ${stats.scans}
• Trades: ${stats.trades} (${stats.confirmedTrades}ok/${stats.revertedTrades}fail)
• Profit: $${stats.totalProfit.toFixed(4)}
• Pertes: $${stats.totalLoss.toFixed(4)}`);
        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    console.log('[MAIN] Ready. Waiting for /start_arb on Telegram.\n');
}

function validateConfig() {
    const warnings = [];
    const errors = [];

    if (!CONFIG.PRIVATE_KEY) {
        warnings.push('PRIVATE_KEY not set - trades disabled');
    }

    if (!CONFIG.TELEGRAM_BOT_TOKEN) {
        warnings.push('TELEGRAM_BOT_TOKEN not set - console only');
    }

    if (CONFIG.TELEGRAM_BOT_TOKEN && !CONFIG.TELEGRAM_CHAT_ID) {
        errors.push('TELEGRAM_CHAT_ID must be set when TELEGRAM_BOT_TOKEN is configured (security)');
    }

    if (!CONFIG.DEX_ROUTER_ADDRESS) {
        warnings.push('DEX_ROUTER_ADDRESS not set - EVM swaps disabled');
    }

    if (!CONFIG.DEX_FACTORY_ADDRESS) {
        warnings.push('DEX_FACTORY_ADDRESS not set - pair lookup disabled');
    }

    if (!CONFIG.DRY_RUN && !CONFIG.PRIVATE_KEY) {
        errors.push('LIVE mode requires PRIVATE_KEY');
    }

    if (CONFIG.TRADE_SIZE_USDC > CONFIG.MAX_TRADE_SIZE_USDC) {
        errors.push(`TRADE_SIZE_USDC ($${CONFIG.TRADE_SIZE_USDC}) > MAX_TRADE_SIZE_USDC ($${CONFIG.MAX_TRADE_SIZE_USDC})`);
    }

    if (warnings.length > 0) {
        console.log('Warnings:');
        warnings.forEach(w => console.log(`  - ${w}`));
        console.log();
    }

    if (errors.length > 0) {
        console.error('Config errors:');
        errors.forEach(e => console.error(`  - ${e}`));
        process.exit(1);
    }
}

main().catch(e => {
    console.error('Fatal:', e);
    process.exit(1);
});
