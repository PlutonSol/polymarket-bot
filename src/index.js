require('dotenv').config();
const CONFIG = require('./config');
const ArbitrageEngine = require('./arbitrage');
const TelegramNotifier = require('./telegram');

/**
 * Bot d'arbitrage Hyperliquid (L1 spot) <-> HyperEVM (DEX AMM)
 *
 * Architecture:
 * ┌─────────────────────────────────────────────┐
 * │             Arbitrage Engine                 │
 * │                                              │
 * │  ┌──────────────┐    ┌───────────────────┐   │
 * │  │ Hyperliquid   │    │  HyperEVM DEX     │   │
 * │  │ (Spot L1)     │    │  (AMM on-chain)   │   │
 * │  │               │    │                   │   │
 * │  │ - Prix bid/ask│    │ - Prix reserves   │   │
 * │  │ - Place orders│    │ - Swap tokens     │   │
 * │  └──────────────┘    └───────────────────┘   │
 * │           │                    │              │
 * │           └──── Compare ───────┘              │
 * │                    │                          │
 * │            Si spread > seuil                  │
 * │           ┌────────┴────────┐                 │
 * │           │ Execute Arb     │                 │
 * │           │ Buy low/Sell hi │                 │
 * │           └────────┬────────┘                 │
 * │                    │                          │
 * │           ┌────────┴────────┐                 │
 * │           │ Telegram Alert  │                 │
 * │           └─────────────────┘                 │
 * └─────────────────────────────────────────────┘
 *
 * Usage:
 *   1. Copier .env.example → .env
 *   2. Remplir les variables d'environnement
 *   3. npm install
 *   4. npm start
 *   5. Sur Telegram: /start_arb pour démarrer
 */

async function main() {
    console.log('='.repeat(50));
    console.log('  Bot Arbitrage Hyperliquid / HyperEVM');
    console.log('='.repeat(50));
    console.log();

    // Validation de la config
    validateConfig();

    // Initialiser les modules
    const telegram = new TelegramNotifier();
    const arbEngine = new ArbitrageEngine(telegram);

    // Connecter les modules
    telegram.init(arbEngine);

    // Message de démarrage
    await telegram.send(`🤖 *Bot Arbitrage Hyperliquid/HyperEVM*

✅ Bot initialisé et prêt

⚙️ *Configuration:*
• Spread min: ${CONFIG.MIN_SPREAD_PCT}%
• Taille trade: $${CONFIG.TRADE_SIZE_USDC}
• Slippage max: ${CONFIG.MAX_SLIPPAGE_PCT}%
• Mode: ${CONFIG.DRY_RUN ? '🧪 Dry Run' : '🔴 LIVE'}
• Tokens: ${CONFIG.TOKENS.map(t => t.symbol).join(', ')}
• Intervalle: ${CONFIG.SCAN_INTERVAL_MS}ms

📋 *Commandes:*
/start\\_arb - Démarrer
/stop\\_arb - Arrêter
/stats - Statistiques
/opps - Opportunités
/prices - Prix
/help - Aide

Tapez /start\\_arb pour commencer le scan.`);

    // Si AUTO_START est défini, démarrer automatiquement
    if (process.env.AUTO_START === 'true') {
        console.log('[MAIN] Auto-starting arbitrage engine...');
        arbEngine.start();
    }

    // Gérer l'arrêt propre
    const shutdown = async (signal) => {
        console.log(`\n[MAIN] ${signal} received, shutting down...`);
        arbEngine.stop();
        const stats = arbEngine.getStats();
        await telegram.send(`🔴 *Bot arrêté* (${signal})

📊 Session:
• Durée: ${stats.uptimeStr}
• Scans: ${stats.scans}
• Opportunités: ${stats.opportunities}
• Trades: ${stats.trades}
• Profit: $${stats.totalProfit.toFixed(4)}`);

        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Garder le process actif
    console.log('[MAIN] Bot ready. Waiting for Telegram commands...\n');
}

/**
 * Valide la configuration minimale
 */
function validateConfig() {
    const warnings = [];
    const errors = [];

    if (!CONFIG.PRIVATE_KEY) {
        warnings.push('PRIVATE_KEY non défini - trades désactivés');
    }

    if (!CONFIG.TELEGRAM_BOT_TOKEN) {
        warnings.push('TELEGRAM_BOT_TOKEN non défini - notifications par console uniquement');
    }

    if (!CONFIG.DEX_ROUTER_ADDRESS) {
        warnings.push('DEX_ROUTER_ADDRESS non défini - swaps EVM désactivés');
    }

    if (!CONFIG.DEX_FACTORY_ADDRESS) {
        warnings.push('DEX_FACTORY_ADDRESS non défini - lecture des paires désactivée');
    }

    if (CONFIG.TOKENS.length === 0) {
        errors.push('Aucun token configuré dans TOKENS');
    }

    if (!CONFIG.DRY_RUN && !CONFIG.PRIVATE_KEY) {
        errors.push('Mode LIVE activé mais PRIVATE_KEY non défini!');
    }

    if (warnings.length > 0) {
        console.log('⚠️  Avertissements:');
        warnings.forEach(w => console.log(`   - ${w}`));
        console.log();
    }

    if (errors.length > 0) {
        console.error('❌ Erreurs de configuration:');
        errors.forEach(e => console.error(`   - ${e}`));
        process.exit(1);
    }
}

main().catch(e => {
    console.error('❌ Fatal error:', e);
    process.exit(1);
});
