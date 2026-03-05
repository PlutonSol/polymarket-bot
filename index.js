const { CONFIG, validateConfig } = require('./src/config');
const log = require('./src/logger');
const PolymarketClient = require('./src/polymarket-client');
const LLMAnalyzer = require('./src/llm-analyzer');
const TradingEngine = require('./src/trading-engine');
const TelegramController = require('./src/telegram-bot');

async function main() {
    console.log(`
╔══════════════════════════════════════════════╗
║   ⚡ Polymarket Scalping Bot v7.0            ║
║   Buy @ bid → Sell @ bid+${(CONFIG.SCALP_TICK * 100).toFixed(0)}c              ║
║   Marchés >= $${(CONFIG.MIN_MARKET_VOLUME / 1e6).toFixed(0)}M volume uniquement       ║
║   LLM: ${CONFIG.LLM_PROVIDER.toUpperCase().padEnd(10)}                         ║
╚══════════════════════════════════════════════╝
`);

    const errors = validateConfig();
    if (errors.length > 0) {
        console.error('❌ Erreurs de configuration:');
        errors.forEach(e => console.error(`   - ${e}`));
        console.error('\nCopier .env.example vers .env et remplir les valeurs.');
        process.exit(1);
    }

    log.info('Configuration OK');
    log.info(`Mode: ${CONFIG.DRY_RUN ? 'DRY RUN' : 'LIVE TRADING'}`);
    log.info(`Stratégie: Buy @ best bid → Sell @ +${CONFIG.SCALP_TICK * 100}c`);
    log.info(`Taille: $${CONFIG.TRADE_SIZE_USD} par scalp`);
    log.info(`Volume cible: $${CONFIG.DAILY_VOLUME_TARGET}/jour`);
    log.info(`Min volume marché: $${(CONFIG.MIN_MARKET_VOLUME / 1e6).toFixed(0)}M`);

    const polyClient = new PolymarketClient();
    await polyClient.initialize();

    const llmAnalyzer = new LLMAnalyzer();
    const tradingEngine = new TradingEngine(polyClient, llmAnalyzer);
    const telegram = new TelegramController(tradingEngine, polyClient, llmAnalyzer);

    await telegram.initialize();

    log.info('Bot prêt - en attente de commandes Telegram');

    const shutdown = async (signal) => {
        log.info(`${signal} - arrêt...`);
        tradingEngine.stop();
        await telegram.send('⚠️ Bot arrêté');
        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('uncaughtException', (e) => log.error('Uncaught:', e.message));
    process.on('unhandledRejection', (e) => log.error('Unhandled:', e.message || e));
}

main().catch(e => {
    console.error('❌ Fatal:', e);
    process.exit(1);
});
