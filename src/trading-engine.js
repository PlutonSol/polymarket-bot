const { CONFIG } = require('./config');
const log = require('./logger');

/**
 * Moteur de scalping - Achète au best bid et revend immédiatement +0.01
 * Cible uniquement les marchés avec volume >= 1M et spread < 0.2c
 * Max 20% du wallet engagé par trade
 */
class TradingEngine {
    constructor(polyClient, llmAnalyzer) {
        this.poly = polyClient;
        this.llm = llmAnalyzer;
        this.isRunning = false;
        this.loopTimeout = null;

        // État
        this.state = {
            dailyVolume: 0,
            dailyTrades: [],
            dailyScalps: 0,        // Nombre de scalps complets (buy+sell)
            dailyProfit: 0,        // Profit théorique des scalps
            activeScalps: [],      // Scalps en cours (buy placé, en attente de sell)
            lastResetDate: new Date().toDateString(),
            totalCycles: 0,
        };

        this.stats = {
            totalScalps: 0,
            totalVolume: 0,
            completedScalps: 0,    // Buy + Sell réussis
            failedScalps: 0,       // Sell non exécuté
            llmCalls: 0,
        };
    }

    async start() {
        if (this.isRunning) return 'Déjà en cours';
        this.isRunning = true;
        log.info('Scalping démarré');
        this._runLoop();
        return 'Scalping démarré';
    }

    stop() {
        this.isRunning = false;
        if (this.loopTimeout) {
            clearTimeout(this.loopTimeout);
            this.loopTimeout = null;
        }
        log.info('Scalping arrêté');
        return 'Scalping arrêté';
    }

    async _runLoop() {
        while (this.isRunning) {
            try {
                this._checkDayReset();
                await this._executeScalpCycle();
                this.state.totalCycles++;
            } catch (error) {
                log.error('Erreur cycle:', error.message);
            }

            if (this.isRunning) {
                await new Promise(r => {
                    this.loopTimeout = setTimeout(r, CONFIG.SCALP_INTERVAL);
                });
            }
        }
    }

    _checkDayReset() {
        const today = new Date().toDateString();
        if (today !== this.state.lastResetDate) {
            log.info('Reset journalier');
            this.state.dailyVolume = 0;
            this.state.dailyTrades = [];
            this.state.dailyScalps = 0;
            this.state.dailyProfit = 0;
            this.state.lastResetDate = today;
        }
    }

    /**
     * Cycle de scalping principal:
     * 1. Récupérer marchés >= 1M volume
     * 2. Enrichir avec orderbook
     * 3. LLM sélectionne les meilleurs targets
     * 4. Exécuter les scalps (buy + sell immédiat à +0.01)
     */
    async _executeScalpCycle() {
        if (this.state.dailyVolume >= CONFIG.DAILY_VOLUME_TARGET) {
            log.info(`Volume cible atteint: $${this.state.dailyVolume.toFixed(0)} / $${CONFIG.DAILY_VOLUME_TARGET}`);
            return;
        }

        log.info(`=== Cycle #${this.state.totalCycles + 1} | Vol: $${this.state.dailyVolume.toFixed(0)}/$${CONFIG.DAILY_VOLUME_TARGET} | Scalps: ${this.state.dailyScalps} ===`);

        // 1. Récupérer marchés à gros volume
        const markets = await this.poly.getCachedHighVolumeMarkets();
        if (markets.length === 0) {
            log.warn('Aucun marché >= $1M trouvé');
            return;
        }
        log.info(`${markets.length} marchés >= $1M volume`);

        // 2. Enrichir avec orderbooks (max 8 en parallèle)
        const toEnrich = markets.slice(0, 8);
        const enriched = (await Promise.all(
            toEnrich.map(m => this.poly.enrichForScalping(m).catch(() => null))
        )).filter(Boolean);

        if (enriched.length === 0) {
            log.warn('Aucun orderbook disponible');
            return;
        }

        // Pre-filtrer: garder seulement ceux avec spread <= MAX_SPREAD_CENTS (0.2c)
        // On veut des marchés ultra-liquides avec un spread très serré
        const viable = enriched.filter(m => {
            const yesOk = m.yesBook && m.yesBook.spreadCents > 0 && m.yesBook.spreadCents <= CONFIG.MAX_SPREAD_CENTS;
            const noOk = m.noBook && m.noBook.spreadCents > 0 && m.noBook.spreadCents <= CONFIG.MAX_SPREAD_CENTS;
            return yesOk || noOk;
        });

        if (viable.length === 0) {
            log.info(`Aucun marché avec spread <= ${CONFIG.MAX_SPREAD_CENTS}c`);
            return;
        }

        log.info(`${viable.length} marchés avec spread <= ${CONFIG.MAX_SPREAD_CENTS}c`);

        // 3. LLM sélectionne les meilleurs targets
        this.stats.llmCalls++;
        const { targets, skipped } = await this.llm.selectScalpTargets(viable);

        if (targets.length === 0) {
            log.info('LLM: aucun target viable');
            if (skipped.length > 0) log.info('Skip:', skipped.join(' | '));
            return;
        }

        log.info(`${targets.length} targets sélectionnés par LLM`);

        // 4. Exécuter les scalps
        const maxScalps = Math.min(targets.length, CONFIG.MAX_CONCURRENT_SCALPS);
        for (let i = 0; i < maxScalps; i++) {
            if (!this.isRunning) break;
            if (this.state.dailyVolume >= CONFIG.DAILY_VOLUME_TARGET) break;

            const target = targets[i];
            await this._executeScalp(target);

            // Petite pause entre scalps
            if (i < maxScalps - 1) {
                await new Promise(r => setTimeout(r, 1500));
            }
        }
    }

    /**
     * Exécute un scalp complet: BUY au bestBid puis SELL à bestBid + 0.01
     * La taille est limitée à 20% du wallet
     */
    async _executeScalp(target) {
        const { tokenId, buyPrice, sellPrice, sizeUsd, market } = target;

        // Validation
        if (!tokenId || !buyPrice || !sellPrice) {
            log.warn('Target invalide:', target);
            return;
        }

        const priceDiff = +(sellPrice - buyPrice).toFixed(4);
        if (Math.abs(priceDiff - CONFIG.SCALP_TICK) > 0.005) {
            log.warn(`Tick invalide: buy=${buyPrice} sell=${sellPrice} diff=${priceDiff}`);
            return;
        }

        // Calculer la taille max basée sur 20% du wallet
        const maxFromWallet = await this.poly.getMaxTradeSize();
        if (maxFromWallet < CONFIG.MIN_TRADE_SIZE) {
            log.warn(`Wallet trop faible: max trade=$${maxFromWallet.toFixed(2)} (20% du wallet)`);
            return;
        }

        const desiredSize = sizeUsd || CONFIG.TRADE_SIZE_USD;
        const size = Math.min(Math.max(desiredSize, CONFIG.MIN_TRADE_SIZE), maxFromWallet);
        const shares = +(size / buyPrice).toFixed(2);

        log.trade(`Wallet 20% cap: $${maxFromWallet.toFixed(2)} | Taille effective: $${size.toFixed(2)}`);

        log.trade(`--- SCALP: ${market || 'N/A'} ---`);
        log.trade(`BUY ${shares} shares @ ${buyPrice} ($${size.toFixed(2)})`);
        log.trade(`SELL cible: ${shares} shares @ ${sellPrice} (+${priceDiff * 100}c)`);

        // Re-vérifier l'orderbook juste avant d'exécuter
        const freshBook = await this.poly.analyzeBookForScalp(tokenId);
        const check = await this.llm.quickBookCheck(freshBook, market);
        if (!check.ok) {
            log.warn(`Scalp annulé (book changé): ${check.reason}`);
            return;
        }

        // Ajuster le prix si le book a bougé
        let finalBuyPrice = buyPrice;
        let finalSellPrice = sellPrice;
        if (freshBook && freshBook.bestBid !== buyPrice) {
            finalBuyPrice = freshBook.bestBid;
            finalSellPrice = +(freshBook.bestBid + CONFIG.SCALP_TICK).toFixed(2);
            log.trade(`Prix ajusté: buy=${finalBuyPrice} sell=${finalSellPrice}`);
        }

        // Vérifier que le sell sera dans le spread ou au ask
        if (freshBook && finalSellPrice > freshBook.bestAsk) {
            log.warn(`Sell ${finalSellPrice} > bestAsk ${freshBook.bestAsk} - skip`);
            return;
        }

        // Vérifier que le spread est toujours <= MAX_SPREAD_CENTS
        if (freshBook && freshBook.spreadCents > CONFIG.MAX_SPREAD_CENTS) {
            log.warn(`Spread ${freshBook.spreadCents}c > max ${CONFIG.MAX_SPREAD_CENTS}c - skip`);
            return;
        }

        try {
            // === ÉTAPE 1: BUY ===
            const buyResult = await this.poly.placeOrder({
                tokenId,
                side: 'buy',
                price: finalBuyPrice,
                size: shares,
            });

            if (!buyResult) {
                log.error('Buy échoué');
                this.stats.failedScalps++;
                return;
            }

            const buyVolume = size;
            this.state.dailyVolume += buyVolume;
            this.state.dailyTrades.push({
                type: 'scalp-buy',
                market,
                tokenId,
                price: finalBuyPrice,
                shares,
                usd: size,
                orderId: buyResult.id,
                time: new Date().toISOString(),
            });
            this.stats.totalVolume += buyVolume;

            log.trade(`BUY OK: ${buyResult.id} | Vol: +$${buyVolume.toFixed(2)}`);

            // Petite pause pour laisser le buy se fill
            await new Promise(r => setTimeout(r, 500));

            // === ÉTAPE 2: SELL immédiat à +0.01 ===
            const sellShares = shares;
            const sellResult = await this.poly.placeOrder({
                tokenId,
                side: 'sell',
                price: finalSellPrice,
                size: sellShares,
            });

            if (!sellResult) {
                log.error('Sell échoué - position ouverte!');
                this.state.activeScalps.push({
                    market,
                    tokenId,
                    buyPrice: finalBuyPrice,
                    sellPrice: finalSellPrice,
                    shares,
                    buyOrderId: buyResult.id,
                    time: new Date().toISOString(),
                });
                this.stats.failedScalps++;
                return;
            }

            const sellVolume = sellShares * finalSellPrice;
            this.state.dailyVolume += sellVolume;
            this.state.dailyTrades.push({
                type: 'scalp-sell',
                market,
                tokenId,
                price: finalSellPrice,
                shares: sellShares,
                usd: sellVolume,
                orderId: sellResult.id,
                time: new Date().toISOString(),
            });
            this.stats.totalVolume += sellVolume;

            // Profit du scalp
            const profit = (finalSellPrice - finalBuyPrice) * shares;
            this.state.dailyProfit += profit;
            this.state.dailyScalps++;
            this.stats.completedScalps++;
            this.stats.totalScalps++;

            log.trade(`SELL OK: ${sellResult.id} | Vol: +$${sellVolume.toFixed(2)} | Profit: +$${profit.toFixed(4)}`);
            log.trade(`Scalp complet! Volume total jour: $${this.state.dailyVolume.toFixed(2)}`);

        } catch (error) {
            log.error(`Erreur scalp:`, error.message);
            this.stats.failedScalps++;
        }
    }

    /**
     * Retente de vendre les positions ouvertes (scalps incomplets)
     */
    async retryFailedScalps() {
        const active = [...this.state.activeScalps];
        if (active.length === 0) return 'Aucun scalp en attente';

        let retried = 0;
        for (const scalp of active) {
            try {
                const result = await this.poly.placeOrder({
                    tokenId: scalp.tokenId,
                    side: 'sell',
                    price: scalp.sellPrice,
                    size: scalp.shares,
                });
                if (result) {
                    this.state.activeScalps = this.state.activeScalps.filter(s => s.buyOrderId !== scalp.buyOrderId);
                    retried++;
                    log.trade(`Retry sell OK: ${scalp.market}`);
                }
            } catch (error) {
                log.error(`Retry sell échoué: ${scalp.market} - ${error.message}`);
            }
        }
        return `${retried}/${active.length} sells retentés`;
    }

    async getStatus() {
        const walletBalance = await this.poly.getWalletBalance();
        const maxTradeSize = walletBalance * CONFIG.MAX_WALLET_EXPOSURE;
        return {
            isRunning: this.isRunning,
            mode: CONFIG.DRY_RUN ? 'DRY RUN' : 'LIVE',
            dailyVolume: this.state.dailyVolume,
            dailyTarget: CONFIG.DAILY_VOLUME_TARGET,
            dailyProgress: ((this.state.dailyVolume / CONFIG.DAILY_VOLUME_TARGET) * 100).toFixed(1),
            dailyScalps: this.state.dailyScalps,
            dailyProfit: this.state.dailyProfit,
            activeScalps: this.state.activeScalps.length,
            totalCycles: this.state.totalCycles,
            scalpTick: CONFIG.SCALP_TICK,
            tradeSize: CONFIG.TRADE_SIZE_USD,
            minVolume: CONFIG.MIN_MARKET_VOLUME,
            maxSpread: CONFIG.MAX_SPREAD_CENTS,
            walletBalance,
            maxTradeSize,
            walletExposure: CONFIG.MAX_WALLET_EXPOSURE * 100,
            stats: { ...this.stats },
        };
    }

    getDailyTrades() {
        return this.state.dailyTrades;
    }

    getActiveScalps() {
        return this.state.activeScalps;
    }
}

module.exports = TradingEngine;
