const TelegramBot = require('node-telegram-bot-api');
const CONFIG = require('./config');

/**
 * Module Telegram pour les notifications et commandes du bot d'arbitrage
 */
class TelegramNotifier {
    constructor() {
        this.bot = null;
        this.arbEngine = null; // Référence au moteur d'arbitrage (injectée après)
    }

    /**
     * Initialise le bot Telegram
     */
    init(arbEngine) {
        this.arbEngine = arbEngine;

        if (!CONFIG.TELEGRAM_BOT_TOKEN) {
            console.log('[TG] No Telegram token configured, notifications disabled');
            return;
        }

        this.bot = new TelegramBot(CONFIG.TELEGRAM_BOT_TOKEN, { polling: true });
        this._setupCommands();
        console.log('[TG] Telegram bot initialized');
    }

    /**
     * Configure les commandes Telegram
     */
    _setupCommands() {
        const chatGuard = (msg) => {
            if (CONFIG.TELEGRAM_CHAT_ID && msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) {
                return false;
            }
            return true;
        };

        // /start - Démarrer le bot d'arbitrage
        this.bot.onText(/\/start_arb/, async (msg) => {
            if (!chatGuard(msg)) return;
            if (this.arbEngine && !this.arbEngine.isRunning) {
                this.arbEngine.start();
                await this.send(`🟢 *Arbitrage activé*

⚙️ Config:
• Spread min: ${CONFIG.MIN_SPREAD_PCT}%
• Taille: $${CONFIG.TRADE_SIZE_USDC}
• Slippage max: ${CONFIG.MAX_SLIPPAGE_PCT}%
• Intervalle: ${CONFIG.SCAN_INTERVAL_MS}ms
• Mode: ${CONFIG.DRY_RUN ? '🧪 Dry Run' : '🔴 LIVE'}
• Tokens: ${CONFIG.TOKENS.map(t => t.symbol).join(', ')}`);
            } else {
                await this.send('⚠️ Arbitrage déjà actif');
            }
        });

        // /stop - Arrêter
        this.bot.onText(/\/stop_arb/, async (msg) => {
            if (!chatGuard(msg)) return;
            if (this.arbEngine) {
                this.arbEngine.stop();
                await this.send('🔴 *Arbitrage arrêté*');
            }
        });

        // /stats - Statistiques
        this.bot.onText(/\/stats/, async (msg) => {
            if (!chatGuard(msg)) return;
            if (!this.arbEngine) return;

            const stats = this.arbEngine.getStats();
            await this.send(`📊 *Statistiques*

⏱ Uptime: ${stats.uptimeStr}
🔍 Scans: ${stats.scans.toLocaleString()}
💡 Opportunités: ${stats.opportunities}
📈 Trades: ${stats.trades}
💰 Profit total: $${stats.totalProfit.toFixed(4)}
📉 Profit moyen: $${stats.avgProfitPerTrade.toFixed(4)}
🎯 Taux opportunités: ${stats.successRate}
⚠️ Erreurs: ${stats.errors}
🤖 Mode: ${CONFIG.DRY_RUN ? 'Dry Run' : 'LIVE'}`);
        });

        // /opps - Dernières opportunités
        this.bot.onText(/\/opps/, async (msg) => {
            if (!chatGuard(msg)) return;
            if (!this.arbEngine) return;

            const opps = this.arbEngine.getRecentOpportunities(5);
            if (opps.length === 0) {
                return await this.send('📋 Aucune opportunité récente');
            }

            let text = '📋 *Dernières opportunités:*\n\n';
            for (const opp of opps) {
                const emoji = opp.profitable ? '💰' : '👀';
                const time = new Date(opp.timestamp).toLocaleTimeString('fr-FR');
                text += `${emoji} *${opp.token}* (${time})\n`;
                text += `  Spread: ${opp.spread.toFixed(3)}% | Net: $${opp.netProfit.toFixed(4)}\n`;
                text += `  ${opp.buyVenue} → ${opp.sellVenue}\n\n`;
            }

            await this.send(text);
        });

        // /prices - Prix actuels
        this.bot.onText(/\/prices/, async (msg) => {
            if (!chatGuard(msg)) return;

            let text = '💱 *Prix actuels:*\n\n';
            for (const token of CONFIG.TOKENS) {
                try {
                    const [hlData, evmData] = await Promise.all([
                        this.arbEngine.hl.getSpotBestBidAsk(token.hyperliquidName),
                        this.arbEngine.evm.getTokenPriceFromPair(token.evmAddress),
                    ]);

                    const hlMid = hlData ? ((hlData.bestBid + hlData.bestAsk) / 2).toFixed(4) : 'N/A';
                    const evmPrice = evmData ? evmData.price.toFixed(4) : 'N/A';
                    const spread = (hlData && evmData)
                        ? (((evmData.price - (hlData.bestBid + hlData.bestAsk) / 2) / ((hlData.bestBid + hlData.bestAsk) / 2)) * 100).toFixed(3)
                        : 'N/A';

                    text += `*${token.symbol}:*\n`;
                    text += `  HL: $${hlMid}\n`;
                    text += `  EVM: $${evmPrice}\n`;
                    text += `  Spread: ${spread}%\n`;
                    if (evmData) {
                        text += `  Liquidité EVM: $${evmData.liquidity.toFixed(0)}\n`;
                    }
                    text += '\n';
                } catch (e) {
                    text += `*${token.symbol}:* Error - ${e.message}\n\n`;
                }
            }

            await this.send(text);
        });

        // /config - Voir la config
        this.bot.onText(/\/config/, async (msg) => {
            if (!chatGuard(msg)) return;
            await this.send(`⚙️ *Configuration*

• Spread min: ${CONFIG.MIN_SPREAD_PCT}%
• Taille trade: $${CONFIG.TRADE_SIZE_USDC}
• Taille max: $${CONFIG.MAX_TRADE_SIZE_USDC}
• Slippage max: ${CONFIG.MAX_SLIPPAGE_PCT}%
• Gas max: ${CONFIG.MAX_GAS_PRICE_GWEI} gwei
• Intervalle: ${CONFIG.SCAN_INTERVAL_MS}ms
• Mode: ${CONFIG.DRY_RUN ? '🧪 Dry Run' : '🔴 LIVE'}
• RPC: ${CONFIG.HYPERL_EVM_RPC}
• Tokens: ${CONFIG.TOKENS.map(t => t.symbol).join(', ')}`);
        });

        // /setspread X - Changer le spread minimum
        this.bot.onText(/\/setspread (.+)/, async (msg, match) => {
            if (!chatGuard(msg)) return;
            const value = parseFloat(match[1]);
            if (isNaN(value) || value < 0) {
                return await this.send('❌ Valeur invalide. Ex: /setspread 0.5');
            }
            CONFIG.MIN_SPREAD_PCT = value;
            await this.send(`✅ Spread minimum: *${value}%*`);
        });

        // /setsize X - Changer la taille de trade
        this.bot.onText(/\/setsize (.+)/, async (msg, match) => {
            if (!chatGuard(msg)) return;
            const value = parseFloat(match[1]);
            if (isNaN(value) || value <= 0) {
                return await this.send('❌ Valeur invalide. Ex: /setsize 200');
            }
            CONFIG.TRADE_SIZE_USDC = value;
            await this.send(`✅ Taille trade: *$${value}*`);
        });

        // /golive - Passer en mode live (désactiver dry-run)
        this.bot.onText(/\/golive/, async (msg) => {
            if (!chatGuard(msg)) return;
            CONFIG.DRY_RUN = false;
            await this.send(`🔴 *MODE LIVE ACTIVÉ*\n⚠️ Les trades seront exécutés réellement!`);
        });

        // /dryrun - Repasser en dry-run
        this.bot.onText(/\/dryrun/, async (msg) => {
            if (!chatGuard(msg)) return;
            CONFIG.DRY_RUN = true;
            await this.send(`🧪 *Mode Dry Run activé*\nAucun trade ne sera exécuté.`);
        });

        // /help
        this.bot.onText(/\/help/, async (msg) => {
            if (!chatGuard(msg)) return;
            await this.send(`🤖 *Bot Arbitrage Hyperliquid/HyperEVM*

📋 *Commandes:*
/start\\_arb - Démarrer l'arbitrage
/stop\\_arb - Arrêter l'arbitrage
/stats - Statistiques
/opps - Dernières opportunités
/prices - Prix actuels
/config - Voir la configuration
/setspread X - Spread minimum (%)
/setsize X - Taille de trade ($)
/golive - Mode LIVE (trades réels)
/dryrun - Mode test (pas de trades)
/help - Aide`);
        });
    }

    /**
     * Envoie un message Telegram
     */
    async send(message) {
        if (!this.bot) {
            console.log('[TG-disabled]', message.replace(/\*/g, '').replace(/\n/g, ' | '));
            return;
        }

        try {
            await this.bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message, {
                parse_mode: 'Markdown',
                disable_web_page_preview: true,
            });
        } catch (e) {
            console.error('[TG] Send error:', e.message);
        }
    }

    /**
     * Notifie une opportunité d'arbitrage
     */
    async sendOpportunity(opp) {
        const emoji = opp.profitable ? '💰' : '👀';
        const dirEmoji = opp.direction === 'BUY_HL_SELL_EVM' ? '📤' : '📥';

        const message = `${emoji} *Opportunité ${opp.token}*

${dirEmoji} *${opp.direction}*
📊 Acheter sur: ${opp.buyVenue} @ $${opp.buyPrice.toFixed(4)}
📊 Vendre sur: ${opp.sellVenue} @ $${opp.sellPrice.toFixed(4)}

📈 Spread: ${opp.spread.toFixed(3)}%
💵 Profit brut: $${opp.grossProfit.toFixed(4)}
⛽ Gas: $${opp.gasCost.toFixed(4)}
💰 Profit net: *$${opp.netProfit.toFixed(4)}*
📉 Impact: ${opp.priceImpact.toFixed(3)}%
🏦 Liquidité EVM: $${opp.evmLiquidity.toFixed(0)}
${opp.profitable ? '✅ Profitable' : '❌ Non profitable'}`;

        await this.send(message);
    }

    /**
     * Notifie l'exécution d'un trade
     */
    async sendTradeExecution(opp, results) {
        const message = `✅ *TRADE EXÉCUTÉ*

🪙 ${opp.token}
💰 Profit estimé: $${opp.netProfit.toFixed(4)}
📊 ${opp.buyVenue} → ${opp.sellVenue}

EVM TX: ${results.evmResult?.txHash || 'N/A'}
HL Order: ${results.hlResult?.status || 'N/A'}`;

        await this.send(message);
    }

    /**
     * Notifie une erreur
     */
    async sendError(message) {
        await this.send(`⚠️ *Erreur:* ${message}`);
    }
}

module.exports = TelegramNotifier;
