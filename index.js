const { CONFIG, validateConfig } = require('./src/config');
const log = require('./src/logger');
const PolymarketClient = require('./src/polymarket-client');
const LLMAnalyzer = require('./src/llm-analyzer');
const TradingEngine = require('./src/trading-engine');
const TelegramController = require('./src/telegram-bot');

async function main() {
    console.log(`
╔══════════════════════════════════════════════╗
║   ⚡ Polymarket Scalping Bot v8              ║
║   Buy @ bid → Sell @ bid+${(CONFIG.SCALP_TICK * 100).toFixed(0)}c              ║
║   Marchés >= $${(CONFIG.MIN_MARKET_VOLUME / 1e6).toFixed(0)}M | spread <= ${CONFIG.MAX_SPREAD_CENTS}c       ║
║   LLM: ${CONFIG.LLM_PROVIDER.toUpperCase().padEnd(10)}                         ║
╚══════════════════════════════════════════════╝
`);

    const errors = validateConfig();
    if (errors.length > 0) {
        console.error('Erreurs de configuration:');
        errors.forEach(e => console.error(`   - ${e}`));
        console.error('\nCopier .env.example vers .env et remplir les valeurs.');
        process.exit(1);
    }

    log.info('Configuration OK');
    log.info(`Mode: ${CONFIG.DRY_RUN ? 'DRY RUN' : 'LIVE TRADING'}`);
    log.info(`Stratégie: Buy @ best bid -> Sell @ +${CONFIG.SCALP_TICK * 100}c`);
    log.info(`Max 20% wallet | Cycle ${CONFIG.SCALP_INTERVAL / 1000}s`);
    log.info(`Volume cible: $${CONFIG.DAILY_VOLUME_TARGET}/jour`);

    const polyClient = new PolymarketClient();
    await polyClient.initialize();

    const llmAnalyzer = new LLMAnalyzer();
    const tradingEngine = new TradingEngine(polyClient, llmAnalyzer);
    const telegram = new TelegramController(tradingEngine, polyClient, llmAnalyzer);

    await telegram.initialize();

    log.info('Bot prêt - /start pour démarrer');

    const shutdown = async (signal) => {
        log.info(`${signal} - arrêt...`);
        tradingEngine.stop();

        // Annuler tous les ordres GTC ouverts avant de quitter
        try {
            log.info('Annulation des ordres ouverts...');
            await polyClient.cancelAllOrders();
            log.info('Ordres ouverts annulés');
        } catch (e) {
            log.error('Erreur annulation ordres au shutdown:', e.message);
        }

        await telegram.send('Bot arrêté (signal système) - ordres annulés');
        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Uncaught exception: log et exit - le process est dans un état indéfini
    process.on('uncaughtException', (e) => {
        log.error('Uncaught exception - arrêt du bot:', e.message);
        tradingEngine.stop();
        process.exit(1);
    });

    process.on('unhandledRejection', (e) => {
        log.error('Unhandled rejection:', e?.message || String(e));
    });
}

main().catch(e => {
    console.error('Fatal:', e.message || e);
    process.exit(1);
});
