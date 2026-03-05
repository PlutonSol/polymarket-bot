const TelegramBot = require('node-telegram-bot-api');
const { CONFIG } = require('./config');
const log = require('./logger');

/**
 * Bot Telegram - Interface de contrôle pour le scalping bot
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
        log.info('Telegram initialisé');

        await this.send(`🤖 *Polymarket Scalping Bot v7.1*

🧠 *LLM:* ${CONFIG.LLM_PROVIDER} (${CONFIG.LLM_MODEL})
💰 *Mode:* ${CONFIG.DRY_RUN ? '🧪 DRY RUN' : '🔴 LIVE'}
📊 *Stratégie:* Buy @ bid → Sell @ bid+${CONFIG.SCALP_TICK * 100}c
🎯 *Volume cible:* $${CONFIG.DAILY_VOLUME_TARGET}/jour
💳 *Max par trade:* 20% du wallet
📈 *Marchés:* >= $${(CONFIG.MIN_MARKET_VOLUME / 1e6).toFixed(0)}M vol, spread <= ${CONFIG.MAX_SPREAD_CENTS}c
⏱ *Cycle:* ${CONFIG.SCALP_INTERVAL / 1000}s

📋 *Commandes:*
/start\\_scalp - Démarrer le scalping
/stop\\_scalp - Arrêter
/status - État du bot
/markets - Marchés éligibles (>1M vol)
/scan - Scanner les opportunités (LLM)
/trades - Trades du jour
/active - Scalps actifs (positions ouvertes)
/retry - Retenter les sells échoués
/volume - Volume du jour
/setsize X - Changer taille scalp
/setvolume X - Changer volume cible
/dryrun - Basculer dry run/live
/cancel\\_all - Annuler tous les ordres`);
    }

    _auth(msg) {
        return msg.chat.id.toString() === CONFIG.TELEGRAM_CHAT_ID;
    }

    _setupCommands() {
        // === SCALPING CONTROLS ===

        this.bot.onText(/\/start_scalp/, async (msg) => {
            if (!this._auth(msg)) return;
            const result = await this.engine.start();
            await this.send(`🟢 ${result}\nIntervalle: ${CONFIG.SCALP_INTERVAL / 1000}s`);
        });

        this.bot.onText(/\/stop_scalp/, async (msg) => {
            if (!this._auth(msg)) return;
            const result = this.engine.stop();
            await this.send(`🔴 ${result}`);
        });

        // === STATUS ===

        this.bot.onText(/\/status/, async (msg) => {
            if (!this._auth(msg)) return;
            const s = await this.engine.getStatus();
            const bar = this._bar(parseFloat(s.dailyProgress));
            await this.send(`📊 *Status Scalping Bot*

🔄 État: ${s.isRunning ? '🟢 Actif' : '🔴 Arrêté'}
🧪 Mode: ${s.mode}
🧠 LLM: ${CONFIG.LLM_PROVIDER} (${CONFIG.LLM_MODEL})

💰 *Volume:*
${bar} ${s.dailyProgress}%
$${s.dailyVolume.toFixed(0)} / $${s.dailyTarget}

💳 *Wallet:*
• Balance: $${s.walletBalance.toFixed(2)} USDC
• Max par trade (${s.walletExposure}%): $${s.maxTradeSize.toFixed(2)}

⚡ *Scalping:*
• Tick: +${s.scalpTick * 100}c (buy → sell +${s.scalpTick * 100}c)
• Max spread: ${s.maxSpread}c
• Min volume marché: $${(s.minVolume / 1e6).toFixed(0)}M
• Intervalle: ${CONFIG.SCALP_INTERVAL / 1000}s
• Scalps complets: ${s.dailyScalps}
• Profit théorique: $${s.dailyProfit.toFixed(4)}
• Scalps actifs: ${s.activeScalps}
• Cycles: ${s.totalCycles}

📈 *Global:*
• Total scalps: ${s.stats.totalScalps}
• Complets: ${s.stats.completedScalps}
• Échoués: ${s.stats.failedScalps}
• Volume total: $${s.stats.totalVolume.toFixed(0)}
• Appels LLM: ${s.stats.llmCalls}`);
        });

        // === MARCHÉS ===

        this.bot.onText(/\/markets/, async (msg) => {
            if (!this._auth(msg)) return;
            await this.send('🔍 Recherche marchés >= $1M...');

            try {
                this.poly.invalidateCache();
                const markets = await this.poly.getCachedHighVolumeMarkets();
                if (markets.length === 0) {
                    return await this.send('❌ Aucun marché >= $1M trouvé');
                }

                let text = `📊 *Marchés éligibles (>=$1M vol):*\n\n`;
                for (const m of markets.slice(0, 10)) {
                    const title = (m.question || 'N/A').slice(0, 45);
                    const vol = parseFloat(m.volume || m.volumeNum || 0);
                    const vol24 = parseFloat(m.volume24hr || 0);
                    text += `📌 ${title}\n`;
                    text += `   Vol: $${(vol / 1e6).toFixed(1)}M | 24h: $${(vol24 / 1e3).toFixed(0)}K\n\n`;
                }
                text += `_Total: ${markets.length} marchés_`;
                await this.send(text);
            } catch (error) {
                await this.send(`❌ ${error.message}`);
            }
        });

        // === SCAN LLM ===

        this.bot.onText(/\/scan/, async (msg) => {
            if (!this._auth(msg)) return;
            await this.send('🧠 Scan en cours (LLM + orderbooks)...');

            try {
                const markets = await this.poly.getCachedHighVolumeMarkets();
                if (markets.length === 0) {
                    return await this.send('❌ Aucun marché éligible');
                }

                const enriched = (await Promise.all(
                    markets.slice(0, 8).map(m => this.poly.enrichForScalping(m).catch(() => null))
                )).filter(Boolean);

                if (enriched.length === 0) {
                    return await this.send('❌ Aucun orderbook dispo');
                }

                // Pre-filtrer: spread <= MAX_SPREAD_CENTS (0.2c)
                const viable = enriched.filter(m => {
                    const yesOk = m.yesBook && m.yesBook.spreadCents > 0 && m.yesBook.spreadCents <= CONFIG.MAX_SPREAD_CENTS;
                    const noOk = m.noBook && m.noBook.spreadCents > 0 && m.noBook.spreadCents <= CONFIG.MAX_SPREAD_CENTS;
                    return yesOk || noOk;
                });

                let text = `📊 *Scan Orderbooks (${enriched.length} marchés):*\n\n`;

                for (const m of enriched.slice(0, 6)) {
                    const title = (m.question || 'N/A').slice(0, 40);
                    text += `📌 *${title}*\n`;
                    text += `   Vol: $${(m.totalVolume / 1e6).toFixed(1)}M\n`;

                    if (m.yesBook) {
                        const y = m.yesBook;
                        const tag = y.spreadCents > 0 && y.spreadCents <= CONFIG.MAX_SPREAD_CENTS ? '✅' : '❌';
                        text += `   YES: bid=${y.bestBid} ask=${y.bestAsk} spread=${y.spreadCents}c ${tag}\n`;
                        text += `   Depth: bid=$${y.bidDepthUsd.toFixed(0)} ask=$${y.askDepthUsd.toFixed(0)}\n`;
                    }
                    if (m.noBook) {
                        const n = m.noBook;
                        const tag = n.spreadCents > 0 && n.spreadCents <= CONFIG.MAX_SPREAD_CENTS ? '✅' : '❌';
                        text += `   NO:  bid=${n.bestBid} ask=${n.bestAsk} spread=${n.spreadCents}c ${tag}\n`;
                        text += `   Depth: bid=$${n.bidDepthUsd.toFixed(0)} ask=$${n.askDepthUsd.toFixed(0)}\n`;
                    }
                    text += '\n';
                }

                if (viable.length === 0) {
                    text += `\n⚠️ _Aucun marché avec spread <= ${CONFIG.MAX_SPREAD_CENTS}c_`;
                    await this.send(text);
                    return;
                }

                // Appel LLM
                const { targets, skipped } = await this.llm.selectScalpTargets(viable);

                if (targets.length > 0) {
                    text += `\n🎯 *Targets LLM (${targets.length}):*\n`;
                    for (const t of targets) {
                        text += `\n⚡ *${(t.market || '').slice(0, 35)}*\n`;
                        text += `   ${t.token?.toUpperCase()} | Buy: ${t.buyPrice} → Sell: ${t.sellPrice}\n`;
                        text += `   Taille: $${t.sizeUsd} | Score: ${t.score}/100\n`;
                        text += `   _${t.reason || ''}_\n`;
                    }
                } else {
                    text += `\n⚠️ _LLM: aucun target viable_`;
                }

                await this.send(text);
            } catch (error) {
                await this.send(`❌ ${error.message}`);
            }
        });

        // === TRADES ===

        this.bot.onText(/\/trades/, async (msg) => {
            if (!this._auth(msg)) return;
            const trades = this.engine.getDailyTrades();
            if (trades.length === 0) {
                return await this.send('📋 Aucun trade aujourd\'hui');
            }

            let text = `📋 *Trades du jour (${trades.length}):*\n\n`;
            for (const t of trades.slice(-15)) {
                const emoji = t.type === 'scalp-buy' ? '🟢 BUY' : '🔴 SELL';
                const market = (t.market || 'N/A').slice(0, 30);
                text += `${emoji} ${t.shares} @ ${t.price} ($${t.usd.toFixed(2)})\n`;
                text += `   ${market} | ${t.time?.slice(11, 19) || ''}\n\n`;
            }
            await this.send(text);
        });

        this.bot.onText(/\/active/, async (msg) => {
            if (!this._auth(msg)) return;
            const active = this.engine.getActiveScalps();
            if (active.length === 0) {
                return await this.send('✅ Aucun scalp actif (pas de position ouverte)');
            }

            let text = `⚠️ *Scalps actifs (positions ouvertes):*\n\n`;
            for (const s of active) {
                text += `📌 ${(s.market || 'N/A').slice(0, 35)}\n`;
                text += `   Buy: ${s.buyPrice} | Sell cible: ${s.sellPrice}\n`;
                text += `   ${s.shares} shares | ${s.time?.slice(11, 19) || ''}\n\n`;
            }
            text += `\nUtilise /retry pour retenter les sells`;
            await this.send(text);
        });

        this.bot.onText(/\/retry/, async (msg) => {
            if (!this._auth(msg)) return;
            const result = await this.engine.retryFailedScalps();
            await this.send(`🔄 ${result}`);
        });

        // === VOLUME ===

        this.bot.onText(/\/volume/, async (msg) => {
            if (!this._auth(msg)) return;
            const s = await this.engine.getStatus();
            const bar = this._bar(parseFloat(s.dailyProgress));
            await this.send(`💰 *Volume du jour*

${bar}
$${s.dailyVolume.toFixed(0)} / $${s.dailyTarget} (${s.dailyProgress}%)

💳 Wallet: $${s.walletBalance.toFixed(2)} | Max trade: $${s.maxTradeSize.toFixed(2)} (${s.walletExposure}%)
⚡ ${s.dailyScalps} scalps complets
💵 Profit: $${s.dailyProfit.toFixed(4)}`);
        });

        // === SETTINGS ===

        this.bot.onText(/\/setsize (.+)/, async (msg, match) => {
            if (!this._auth(msg)) return;
            const v = parseFloat(match[1]);
            if (isNaN(v) || v <= 0) return await this.send('❌ Ex: /setsize 100');
            CONFIG.TRADE_SIZE_USD = v;
            await this.send(`✅ Taille scalp: *$${v}*`);
        });

        this.bot.onText(/\/setvolume (.+)/, async (msg, match) => {
            if (!this._auth(msg)) return;
            const v = parseFloat(match[1]);
            if (isNaN(v) || v <= 0) return await this.send('❌ Ex: /setvolume 5000');
            CONFIG.DAILY_VOLUME_TARGET = v;
            await this.send(`✅ Volume cible: *$${v}*/jour`);
        });

        this.bot.onText(/\/dryrun/, async (msg) => {
            if (!this._auth(msg)) return;
            CONFIG.DRY_RUN = !CONFIG.DRY_RUN;
            await this.send(`✅ Mode: ${CONFIG.DRY_RUN ? '🧪 DRY RUN' : '🔴 LIVE TRADING'}`);
        });

        this.bot.onText(/\/cancel_all/, async (msg) => {
            if (!this._auth(msg)) return;
            try {
                await this.poly.cancelAllOrders();
                await this.send('✅ Tous les ordres annulés');
            } catch (error) {
                await this.send(`❌ ${error.message}`);
            }
        });
    }

    _bar(pct) {
        const f = Math.round(pct / 5);
        return '▓'.repeat(Math.min(f, 20)) + '░'.repeat(20 - Math.min(f, 20));
    }

    async send(message) {
        try {
            await this.bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message, {
                parse_mode: 'Markdown',
                disable_web_page_preview: true,
            });
        } catch (error) {
            log.error('Telegram:', error.message);
        }
    }

    async notifyScalp(data) {
        await this.send(`⚡ *Scalp exécuté!*

📊 ${(data.market || 'N/A').slice(0, 50)}
🟢 BUY @ ${data.buyPrice} → 🔴 SELL @ ${data.sellPrice}
💵 Volume: $${data.volume?.toFixed(2) || '?'}
💰 Profit: +$${data.profit?.toFixed(4) || '?'}`);
    }
}

module.exports = TelegramController;
