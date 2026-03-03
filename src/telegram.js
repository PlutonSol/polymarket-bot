const TelegramBot = require('node-telegram-bot-api');
const CONFIG = require('./config');

class TelegramNotifier {
    constructor() {
        this.bot = null;
        this.arbEngine = null;
        this.golivePending = false; // Confirmation à double étape
    }

    init(arbEngine) {
        this.arbEngine = arbEngine;

        if (!CONFIG.TELEGRAM_BOT_TOKEN) {
            console.log('[TG] No Telegram token, notifications disabled');
            return;
        }

        this.bot = new TelegramBot(CONFIG.TELEGRAM_BOT_TOKEN, { polling: true });
        this._setupCommands();
        console.log('[TG] Telegram bot initialized');
    }

    _setupCommands() {
        // Sécurité: rejeter si CHAT_ID non configuré ou ne match pas
        const chatGuard = (msg) => {
            if (!CONFIG.TELEGRAM_CHAT_ID) {
                console.warn('[TG] TELEGRAM_CHAT_ID not set, rejecting command');
                return false;
            }
            return msg.chat.id.toString() === CONFIG.TELEGRAM_CHAT_ID;
        };

        this.bot.onText(/\/start_arb/, async (msg) => {
            if (!chatGuard(msg)) return;
            if (this.arbEngine && !this.arbEngine.isRunning) {
                this.arbEngine.start();
                await this.send(`🟢 *Arbitrage HYPE activé*

⚙️ Config:
• Spread min: ${CONFIG.MIN_SPREAD_PCT}%
• Taille: $${CONFIG.TRADE_SIZE_USDC}
• Slippage max: ${CONFIG.MAX_SLIPPAGE_PCT}%
• Intervalle: ${CONFIG.SCAN_INTERVAL_MS}ms
• Max loss: $${CONFIG.MAX_LOSS_USD}
• Max trades/h: ${CONFIG.MAX_TRADES_PER_HOUR}
• Mode: ${CONFIG.DRY_RUN ? '🧪 Dry Run' : '🔴 LIVE'}`);
            } else {
                await this.send('⚠️ Déjà actif');
            }
        });

        this.bot.onText(/\/stop_arb/, async (msg) => {
            if (!chatGuard(msg)) return;
            if (this.arbEngine) {
                this.arbEngine.stop();
                await this.send('🔴 *Arbitrage arrêté*');
            }
        });

        this.bot.onText(/\/stats/, async (msg) => {
            if (!chatGuard(msg)) return;
            if (!this.arbEngine) return;

            const stats = this.arbEngine.getStats();
            await this.send(`📊 *Statistiques HYPE*

⏱ Uptime: ${stats.uptimeStr}
🔍 Scans: ${stats.scans.toLocaleString()}
💡 Opportunités: ${stats.opportunities}
📈 Trades: ${stats.trades} (${stats.tradesLastHour}/h)
✅ Confirmés: ${stats.confirmedTrades} | ❌ Revert: ${stats.revertedTrades}
⏳ Pending: ${stats.pendingTxs}
💰 Profit: $${stats.totalProfit.toFixed(4)}
📉 Moyen: $${stats.avgProfitPerTrade.toFixed(4)}
🎯 Taux: ${stats.successRate}
⚠️ Erreurs: ${stats.errors}
💔 Pertes: $${stats.totalLoss.toFixed(4)}
🛑 CB: ${stats.circuitBroken ? '🔴 ACTIF' : '🟢 OK'}
🤖 Mode: ${CONFIG.DRY_RUN ? 'Dry Run' : 'LIVE'}

⚡ *Vitesse (block-aligned):*
• Scan moyen: ${stats.avgScanMs.toFixed(0)}ms
• Dernier scan: ${stats.lastScanMs}ms
• Exec moyenne: ${stats.avgExecMs.toFixed(0)}ms
• Dernière exec: ${stats.lastExecMs}ms`);
        });

        this.bot.onText(/\/opps/, async (msg) => {
            if (!chatGuard(msg)) return;
            if (!this.arbEngine) return;

            const opps = this.arbEngine.getRecentOpportunities(5);
            if (opps.length === 0) {
                return await this.send('📋 Aucune opportunité récente');
            }

            let text = '📋 *Dernières opportunités HYPE:*\n\n';
            for (const opp of opps) {
                const emoji = opp.profitable ? '💰' : '👀';
                const time = new Date(opp.timestamp).toLocaleTimeString('fr-FR');
                text += `${emoji} (${time})\n`;
                text += `  Spread: ${opp.spread.toFixed(3)}% | Net: $${opp.netProfit.toFixed(4)}\n`;
                text += `  ${opp.buyVenue} → ${opp.sellVenue}\n\n`;
            }
            await this.send(text);
        });

        this.bot.onText(/\/prices/, async (msg) => {
            if (!chatGuard(msg)) return;
            if (!this.arbEngine) return;

            try {
                const [hlData, evmData] = await Promise.all([
                    this.arbEngine.hl.getHypeBestBidAsk(),
                    this.arbEngine.evm.getHypePrice(),
                ]);

                const hlMid = hlData ? ((hlData.bestBid + hlData.bestAsk) / 2).toFixed(4) : 'N/A';
                const evmPrice = evmData ? evmData.price.toFixed(4) : 'N/A';
                const spread = (hlData && evmData)
                    ? (((evmData.price - (hlData.bestBid + hlData.bestAsk) / 2) / ((hlData.bestBid + hlData.bestAsk) / 2)) * 100).toFixed(3)
                    : 'N/A';

                await this.send(`💱 *Prix HYPE:*

📊 Hyperliquid: $${hlMid}
  Bid: $${hlData ? hlData.bestBid.toFixed(4) : 'N/A'} | Ask: $${hlData ? hlData.bestAsk.toFixed(4) : 'N/A'}
📊 HyperEVM: $${evmPrice}
  Liquidité: $${evmData ? evmData.liquidity.toFixed(0) : 'N/A'}

📈 Spread: ${spread}%`);
            } catch (e) {
                await this.send(`❌ Erreur: ${e.message}`);
            }
        });

        this.bot.onText(/\/balances/, async (msg) => {
            if (!chatGuard(msg)) return;
            if (!this.arbEngine) return;

            try {
                const balances = await this.arbEngine.evm.getBalances();
                if (!balances) {
                    return await this.send('❌ Wallet non configuré');
                }
                await this.send(`💼 *Balances EVM:*

• WHYPE: ${balances.hype.toFixed(4)}
• USDC: ${balances.usdc.toFixed(2)}
• HYPE natif: ${balances.nativeHype.toFixed(4)}`);
            } catch (e) {
                await this.send(`❌ Erreur: ${e.message}`);
            }
        });

        this.bot.onText(/\/config/, async (msg) => {
            if (!chatGuard(msg)) return;
            await this.send(`⚙️ *Configuration HYPE*

• Spread min: ${CONFIG.MIN_SPREAD_PCT}%
• Taille trade: $${CONFIG.TRADE_SIZE_USDC}
• Taille max: $${CONFIG.MAX_TRADE_SIZE_USDC}
• Slippage max: ${CONFIG.MAX_SLIPPAGE_PCT}%
• Gas max: ${CONFIG.MAX_GAS_PRICE_GWEI} gwei
• Intervalle: ${CONFIG.SCAN_INTERVAL_MS}ms
• Max loss: $${CONFIG.MAX_LOSS_USD}
• Max trades/h: ${CONFIG.MAX_TRADES_PER_HOUR}
• Mode: ${CONFIG.DRY_RUN ? '🧪 Dry Run' : '🔴 LIVE'}`);
        });

        this.bot.onText(/\/setspread (.+)/, async (msg, match) => {
            if (!chatGuard(msg)) return;
            const value = parseFloat(match[1]);
            if (isNaN(value) || value < 0.01 || value > 10) {
                return await this.send('❌ Valeur invalide (0.01 - 10%). Ex: /setspread 0.5');
            }
            CONFIG.MIN_SPREAD_PCT = value;
            await this.send(`✅ Spread minimum: *${value}%*`);
        });

        this.bot.onText(/\/setsize (.+)/, async (msg, match) => {
            if (!chatGuard(msg)) return;
            const value = parseFloat(match[1]);
            if (isNaN(value) || value < 10 || value > CONFIG.MAX_TRADE_SIZE_USDC) {
                return await this.send(`❌ Valeur invalide ($10 - $${CONFIG.MAX_TRADE_SIZE_USDC}). Ex: /setsize 200`);
            }
            CONFIG.TRADE_SIZE_USDC = value;
            await this.send(`✅ Taille trade: *$${value}*`);
        });

        // /golive avec double confirmation
        this.bot.onText(/\/golive/, async (msg) => {
            if (!chatGuard(msg)) return;
            if (!CONFIG.PRIVATE_KEY) {
                return await this.send('❌ PRIVATE\\_KEY non configurée, impossible de passer en LIVE');
            }
            if (!this.golivePending) {
                this.golivePending = true;
                // Reset après 30s si pas confirmé
                setTimeout(() => { this.golivePending = false; }, 30000);
                return await this.send(`⚠️ *ATTENTION*\nVous allez activer le mode LIVE.\nLes trades seront exécutés avec de vrais fonds.\n\nTapez */golive* à nouveau dans les 30s pour confirmer.`);
            }
            this.golivePending = false;
            CONFIG.DRY_RUN = false;
            await this.send(`🔴 *MODE LIVE ACTIVÉ*\n⚠️ Trades réels activés!`);
        });

        this.bot.onText(/\/dryrun/, async (msg) => {
            if (!chatGuard(msg)) return;
            CONFIG.DRY_RUN = true;
            this.golivePending = false;
            await this.send(`🧪 *Mode Dry Run activé*`);
        });

        // /resetcb - Reset le circuit breaker
        this.bot.onText(/\/resetcb/, async (msg) => {
            if (!chatGuard(msg)) return;
            if (this.arbEngine) {
                this.arbEngine.resetCircuitBreaker();
                await this.send('🟢 *Circuit breaker reset*\nPertes remises à zéro.');
            }
        });

        this.bot.onText(/\/help/, async (msg) => {
            if (!chatGuard(msg)) return;
            await this.send(`🤖 *Bot Arbitrage HYPE*
Hyperliquid L1 ↔ HyperEVM DEX

📋 *Commandes:*
/start\\_arb - Démarrer
/stop\\_arb - Arrêter
/stats - Statistiques + vitesse
/opps - Dernières opportunités
/prices - Prix HYPE actuels
/balances - Balances du wallet
/config - Configuration
/setspread X - Spread min (%)
/setsize X - Taille trade ($)
/golive - Mode LIVE (double confirm)
/dryrun - Mode test
/resetcb - Reset circuit breaker
/help - Aide`);
        });
    }

    async send(message) {
        if (!this.bot) {
            console.log('[TG-off]', message.replace(/\*/g, '').substring(0, 100));
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

    async sendOpportunity(opp) {
        const emoji = opp.profitable ? '💰' : '👀';
        const dir = opp.direction === 'BUY_HL_SELL_EVM' ? '📤' : '📥';

        await this.send(`${emoji} *HYPE ${opp.direction}*

${dir} Buy ${opp.buyVenue} @ $${opp.buyPrice.toFixed(4)}
${dir} Sell ${opp.sellVenue} @ $${opp.sellPrice.toFixed(4)}

📈 Spread: ${opp.spread.toFixed(3)}%
💰 Net: *$${opp.netProfit.toFixed(4)}*
📉 Impact: ${opp.priceImpact.toFixed(3)}%
🏦 Liq: $${opp.evmLiquidity.toFixed(0)}
${opp.profitable ? '✅ Profitable' : '❌ Non profitable'}`);
    }

    async sendTradeExecution(opp, results) {
        await this.send(`✅ *TRADE HYPE EXÉCUTÉ*

💰 Profit: $${opp.netProfit.toFixed(4)}
📊 ${opp.buyVenue} → ${opp.sellVenue}
⚡ Exécution: ${results.execMs || 'N/A'}ms
EVM TX: ${results.evmResult?.txHash || 'N/A'}
HL: ${results.hlResult?.status || 'N/A'}`);
    }

    async sendError(message) {
        await this.send(`⚠️ *Erreur:* ${message}`);
    }
}

module.exports = TelegramNotifier;
