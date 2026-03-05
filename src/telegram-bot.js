const TelegramBot = require('node-telegram-bot-api');
const { CONFIG } = require('./config');
const log = require('./logger');

/**
 * Bot Telegram - Interface de contrôle pour le trading bot
 */
class TelegramController {
    constructor(tradingEngine, polyClient, llmAnalyzer) {
        this.engine = tradingEngine;
        this.poly = polyClient;
        this.llm = llmAnalyzer;
        this.bot = null;
    }

    async initialize() {
        this.bot = new TelegramBot(CONFIG.TELEGRAM_BOT_TOKEN, { polling: true });
        this._setupCommands();
        log.info('Bot Telegram initialisé');

        await this.send(`🤖 *Polymarket LLM Trading Bot v6.0*

🧠 *Powered by:* ${CONFIG.LLM_PROVIDER} (${CONFIG.LLM_MODEL})
💰 *Mode:* ${CONFIG.DRY_RUN ? '🧪 DRY RUN (simulation)' : '🔴 LIVE TRADING'}
🎯 *Volume cible:* $${CONFIG.DAILY_VOLUME_TARGET}/jour
📊 *Taille trades:* $${CONFIG.MIN_TRADE_SIZE} - $${CONFIG.MAX_TRADE_SIZE}

📋 *Commandes:*
/start\\_trade - Démarrer le trading auto
/stop\\_trade - Arrêter le trading
/status - État du bot
/trades - Trades du jour
/positions - Positions ouvertes
/analyze - Analyser les marchés (LLM)
/markets - Top marchés actifs
/volume - Volume du jour
/setvolume X - Changer volume cible
/setsize X - Changer taille max trade
/dryrun - Basculer mode dry run
/cancel\\_all - Annuler tous les ordres`);
    }

    _isAuthorized(msg) {
        return msg.chat.id.toString() === CONFIG.TELEGRAM_CHAT_ID;
    }

    _setupCommands() {
        // === TRADING CONTROLS ===

        this.bot.onText(/\/start_trade/, async (msg) => {
            if (!this._isAuthorized(msg)) return;
            const result = await this.engine.start();
            await this.send(`🟢 ${result}`);
        });

        this.bot.onText(/\/stop_trade/, async (msg) => {
            if (!this._isAuthorized(msg)) return;
            const result = this.engine.stop();
            await this.send(`🔴 ${result}`);
        });

        // === STATUS & INFO ===

        this.bot.onText(/\/status/, async (msg) => {
            if (!this._isAuthorized(msg)) return;
            const s = this.engine.getStatus();
            const progressBar = this._makeProgressBar(parseFloat(s.dailyProgress));
            await this.send(`📊 *Status Bot*

🔄 État: ${s.isRunning ? '🟢 Actif' : '🔴 Arrêté'}
🧪 Mode: ${s.mode}
🧠 LLM: ${CONFIG.LLM_PROVIDER} (${CONFIG.LLM_MODEL})

💰 *Volume du jour:*
${progressBar} ${s.dailyProgress}%
$${s.dailyVolume.toFixed(2)} / $${s.dailyTarget}

📈 *Stats:*
• Trades aujourd'hui: ${s.dailyTradeCount}
• Positions ouvertes: ${s.openPositions}
• Cycles exécutés: ${s.totalCycles}

📊 *Global:*
• Total trades: ${s.stats.totalTrades}
• Volume total: $${s.stats.totalVolume.toFixed(2)}
• Réussis: ${s.stats.successfulTrades}
• Échoués: ${s.stats.failedTrades}
• Appels LLM: ${s.stats.llmCalls}`);
        });

        this.bot.onText(/\/trades/, async (msg) => {
            if (!this._isAuthorized(msg)) return;
            const trades = this.engine.getDailyTrades();
            if (trades.length === 0) {
                return await this.send('📋 Aucun trade aujourd\'hui');
            }

            let text = `📋 *Trades du jour (${trades.length}):*\n\n`;
            for (const t of trades.slice(-10)) {
                const emoji = t.side === 'buy' ? '🟢' : '🔴';
                const market = (t.marketTitle || 'N/A').slice(0, 35);
                text += `${emoji} ${t.side.toUpperCase()} $${parseFloat(t.size).toFixed(2)} @ ${parseFloat(t.price).toFixed(2)}\n`;
                text += `   ${market}\n`;
                text += `   ${t.executedAt?.slice(11, 19) || ''}\n\n`;
            }
            await this.send(text);
        });

        this.bot.onText(/\/positions/, async (msg) => {
            if (!this._isAuthorized(msg)) return;
            const positions = this.engine.getOpenPositions();
            const keys = Object.keys(positions);
            if (keys.length === 0) {
                return await this.send('📊 Aucune position ouverte');
            }

            let text = `📊 *Positions ouvertes (${keys.length}):*\n\n`;
            for (const [tokenId, pos] of Object.entries(positions)) {
                const emoji = pos.side === 'buy' ? '🟢' : '🔴';
                text += `${emoji} ${pos.side.toUpperCase()} - ${pos.size.toFixed(2)} shares @ ${pos.avgPrice.toFixed(2)}\n`;
                text += `   Token: ${tokenId.slice(0, 12)}...\n\n`;
            }
            await this.send(text);
        });

        this.bot.onText(/\/volume/, async (msg) => {
            if (!this._isAuthorized(msg)) return;
            const s = this.engine.getStatus();
            const progressBar = this._makeProgressBar(parseFloat(s.dailyProgress));
            await this.send(`💰 *Volume du jour*

${progressBar}
$${s.dailyVolume.toFixed(2)} / $${s.dailyTarget} (${s.dailyProgress}%)

📊 ${s.dailyTradeCount} trades exécutés`);
        });

        // === LLM ANALYSIS ===

        this.bot.onText(/\/analyze/, async (msg) => {
            if (!this._isAuthorized(msg)) return;
            await this.send('🧠 Analyse en cours...');

            try {
                const markets = await this.poly.getCachedMarkets(15);
                const enriched = (await Promise.all(
                    markets.slice(0, 8).map(m => this.poly.enrichMarketData(m).catch(() => null))
                )).filter(Boolean);

                if (enriched.length === 0) {
                    return await this.send('❌ Aucun marché disponible');
                }

                const analysis = await this.llm.analyzeMarkets(enriched);
                if (!analysis) {
                    return await this.send('❌ Erreur analyse LLM');
                }

                let text = `🧠 *Analyse LLM*\n\n`;
                text += `📝 ${analysis.analysis || 'N/A'}\n\n`;

                if (analysis.trades && analysis.trades.length > 0) {
                    text += `💡 *Trades recommandés:*\n`;
                    for (const t of analysis.trades.slice(0, 5)) {
                        const emoji = t.side === 'buy' ? '🟢' : '🔴';
                        text += `\n${emoji} ${t.side.toUpperCase()} ${t.outcome} @ ${t.price}`;
                        text += ` ($${t.size}) - ${(t.confidence * 100).toFixed(0)}%\n`;
                        text += `   ${(t.marketTitle || '').slice(0, 40)}\n`;
                        text += `   _${t.reason || ''}_\n`;
                    }
                }

                if (analysis.marketInsights && analysis.marketInsights.length > 0) {
                    text += `\n🔍 *Insights:*\n`;
                    for (const i of analysis.marketInsights.slice(0, 3)) {
                        text += `• ${i.insight}\n`;
                    }
                }

                await this.send(text);
            } catch (error) {
                await this.send(`❌ Erreur: ${error.message}`);
            }
        });

        this.bot.onText(/\/markets/, async (msg) => {
            if (!this._isAuthorized(msg)) return;
            await this.send('🔍 Récupération des marchés...');

            try {
                const markets = await this.poly.getCachedMarkets(10);
                const enriched = (await Promise.all(
                    markets.slice(0, 8).map(m => this.poly.enrichMarketData(m).catch(() => null))
                )).filter(Boolean);

                let text = `📊 *Top marchés Polymarket:*\n\n`;
                for (const m of enriched) {
                    const title = (m.question || m.title || 'N/A').slice(0, 45);
                    const spread = m.spread !== null ? `${m.spread.toFixed(1)}%` : 'N/A';
                    text += `📌 ${title}\n`;
                    text += `   Yes: ${m.yesMid ? (m.yesMid * 100).toFixed(0) + '¢' : 'N/A'}`;
                    text += ` | Spread: ${spread}`;
                    text += ` | Vol: $${(m.volume24h || 0).toFixed(0)}\n\n`;
                }
                await this.send(text);
            } catch (error) {
                await this.send(`❌ Erreur: ${error.message}`);
            }
        });

        // === SETTINGS ===

        this.bot.onText(/\/setvolume (.+)/, async (msg, match) => {
            if (!this._isAuthorized(msg)) return;
            const value = parseFloat(match[1]);
            if (isNaN(value) || value <= 0) {
                return await this.send('❌ Valeur invalide. Ex: /setvolume 2000');
            }
            CONFIG.DAILY_VOLUME_TARGET = value;
            await this.send(`✅ Volume cible: *$${value}*/jour`);
        });

        this.bot.onText(/\/setsize (.+)/, async (msg, match) => {
            if (!this._isAuthorized(msg)) return;
            const value = parseFloat(match[1]);
            if (isNaN(value) || value <= 0) {
                return await this.send('❌ Valeur invalide. Ex: /setsize 100');
            }
            CONFIG.MAX_TRADE_SIZE = value;
            await this.send(`✅ Taille max trade: *$${value}*`);
        });

        this.bot.onText(/\/dryrun/, async (msg) => {
            if (!this._isAuthorized(msg)) return;
            CONFIG.DRY_RUN = !CONFIG.DRY_RUN;
            const mode = CONFIG.DRY_RUN ? '🧪 DRY RUN (simulation)' : '🔴 LIVE TRADING';
            await this.send(`✅ Mode: ${mode}`);
        });

        this.bot.onText(/\/cancel_all/, async (msg) => {
            if (!this._isAuthorized(msg)) return;
            try {
                await this.poly.cancelAllOrders();
                await this.send('✅ Tous les ordres ont été annulés');
            } catch (error) {
                await this.send(`❌ Erreur: ${error.message}`);
            }
        });
    }

    _makeProgressBar(percent) {
        const filled = Math.round(percent / 5);
        const empty = 20 - Math.min(filled, 20);
        return '▓'.repeat(Math.min(filled, 20)) + '░'.repeat(empty);
    }

    async send(message) {
        try {
            await this.bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message, {
                parse_mode: 'Markdown',
                disable_web_page_preview: true,
            });
        } catch (error) {
            log.error('Telegram error:', error.message);
        }
    }

    /**
     * Envoie une notification de trade
     */
    async notifyTrade(trade) {
        const emoji = trade.side === 'buy' ? '🟢 ACHAT' : '🔴 VENTE';
        const market = (trade.marketTitle || 'N/A').slice(0, 60);
        await this.send(`🔔 *Trade exécuté*

${emoji} ${trade.outcome || ''}
📊 ${market}
💰 $${parseFloat(trade.size).toFixed(2)} @ ${parseFloat(trade.price).toFixed(2)}
🆔 ${trade.orderId || 'N/A'}`);
    }
}

module.exports = TelegramController;
