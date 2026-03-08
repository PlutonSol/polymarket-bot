const { CONFIG, validateConfig } = require('./src/config');
const log = require('./src/logger');
const PolymarketClient = require('./src/polymarket-client');
const TradingEngine = require('./src/trading-engine');
const TelegramController = require('./src/telegram-bot');

async function main() {
    console.log(`
╔══════════════════════════════════════════════╗
║   Polymarket Scalping Bot v9                 ║
║   Buy @ bid -> Sell @ bid+${(CONFIG.SCALP_TICK * 100).toFixed(0)}c              ║
║   Spread max: ${CONFIG.MAX_SPREAD_CENTS}c | Cycle ${CONFIG.SCALP_INTERVAL / 1000}s          ║
║   /market <slug> pour cibler un marche       ║
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
    log.info(`Strategie: Buy @ best bid -> Sell @ +${CONFIG.SCALP_TICK * 100}c`);
    log.info(`Max 20% wallet | Cycle ${CONFIG.SCALP_INTERVAL / 1000}s`);
    log.info(`Volume cible: $${CONFIG.DAILY_VOLUME_TARGET}/jour`);

    const polyClient = new PolymarketClient();
    await polyClient.initialize();

    const tradingEngine = new TradingEngine(polyClient);
    const telegram = new TelegramController(tradingEngine, polyClient);

    await telegram.initialize();

    log.info('Bot pret - /market <slug> puis /start');

    const shutdown = async (signal) => {
        log.info(`${signal} - arret...`);
        tradingEngine.stop();

        try {
            log.info('Annulation des ordres ouverts...');
            await polyClient.cancelAllOrders();
            log.info('Ordres ouverts annules');
        } catch (e) {
            log.error('Erreur annulation ordres au shutdown:', e.message);
        }

        await telegram.send('Bot arrete (signal systeme) - ordres annules');
        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    process.on('uncaughtException', (e) => {
        log.error('Uncaught exception - arret du bot:', e.message);
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
