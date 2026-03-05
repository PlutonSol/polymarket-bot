const { CONFIG, validateConfig } = require('./src/config');
const log = require('./src/logger');
const PolymarketClient = require('./src/polymarket-client');
const LLMAnalyzer = require('./src/llm-analyzer');
const TradingEngine = require('./src/trading-engine');
const TelegramController = require('./src/telegram-bot');

async function main() {
    console.log(`
╔══════════════════════════════════════════╗
║   🤖 Polymarket LLM Trading Bot v6.0    ║
║   Powered by ${CONFIG.LLM_PROVIDER.toUpperCase().padEnd(10)} + CLOB API     ║
╚══════════════════════════════════════════╝
`);

    // 1. Valider la configuration
    const errors = validateConfig();
    if (errors.length > 0) {
        console.error('❌ Erreurs de configuration:');
        errors.forEach(e => console.error(`   - ${e}`));
        console.error('\nCopier .env.example vers .env et remplir les valeurs.');
        process.exit(1);
    }

    log.info('Configuration validée');
    log.info(`Mode: ${CONFIG.DRY_RUN ? 'DRY RUN (simulation)' : 'LIVE TRADING'}`);
    log.info(`LLM: ${CONFIG.LLM_PROVIDER} (${CONFIG.LLM_MODEL})`);
    log.info(`Volume cible: $${CONFIG.DAILY_VOLUME_TARGET}/jour`);

    // 2. Initialiser les composants
    const polyClient = new PolymarketClient();
    await polyClient.initialize();

    const llmAnalyzer = new LLMAnalyzer();
    const tradingEngine = new TradingEngine(polyClient, llmAnalyzer);
    const telegram = new TelegramController(tradingEngine, polyClient, llmAnalyzer);

    await telegram.initialize();

    log.info('Tous les composants initialisés');
    log.info('En attente de commandes Telegram...');

    // Gestion propre de l'arrêt
    const shutdown = async (signal) => {
        log.info(`Signal ${signal} reçu - arrêt en cours...`);
        tradingEngine.stop();
        await telegram.send('⚠️ Bot arrêté (signal système)');
        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('uncaughtException', (error) => {
        log.error('Uncaught exception:', error.message);
    });
    process.on('unhandledRejection', (error) => {
        log.error('Unhandled rejection:', error.message || error);
    });
}

main().catch(error => {
    console.error('❌ Erreur fatale:', error);
    process.exit(1);
});
