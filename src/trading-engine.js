const { CONFIG } = require('./config');
const log = require('./logger');

/**
 * Moteur de scalping - Achète au best bid et revend immédiatement +0.01
 * Fonctionne sur un marché unique fourni manuellement via /market
 */
class TradingEngine {
    constructor(polyClient) {
        this.poly = polyClient;
        this.isRunning = false;
        this.loopTimeout = null;
        this._scalpsLock = false;

        // Marché cible (défini via setTargetMarket)
        this.targetMarket = null;

        // État
        this.state = {
            dailyVolume: 0,
            dailyTrades: [],
            dailyScalps: 0,
            dailyProfit: 0,
            activeScalps: [],
            lastResetDate: new Date().toDateString(),
            totalCycles: 0,
        };

        this.stats = {
            totalScalps: 0,
            totalVolume: 0,
            completedScalps: 0,
            failedScalps: 0,
        };
    }

    /**
     * Définit le marché cible pour le scalping.
     * @param {object} market - Marché brut depuis l'API Gamma
     * @returns {string} Message de confirmation
     */
    async setTargetMarket(market) {
        const enriched = await this.poly.enrichForScalping(market);
        if (!enriched) {
            return `Impossible d'enrichir le marché: ${market.question || market.slug || 'inconnu'}`;
        }

        this.targetMarket = enriched;
        this.poly.invalidateCache();
        log.info(`Marché cible: ${enriched.question}`);
        return `Marché cible défini: ${enriched.question}`;
    }

    async start() {
        if (this.isRunning) return 'Déjà en cours';
        if (!this.targetMarket) return 'Aucun marché cible. Utilise /market <slug> d\'abord.';
        this.isRunning = true;
        log.info('Scalping démarré');
        this._runLoop();
        return `Scalping démarré sur: ${this.targetMarket.question}`;
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
                await this._checkDayReset();
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

    async _acquireScalpsLock() {
        while (this._scalpsLock) {
            await new Promise(r => setTimeout(r, 10));
        }
        this._scalpsLock = true;
    }

    _releaseScalpsLock() {
        this._scalpsLock = false;
    }

    async _checkDayReset() {
        const today = new Date().toDateString();
        if (today !== this.state.lastResetDate) {
            log.info('Reset journalier');
            this.state.dailyVolume = 0;
            this.state.dailyTrades = [];
            this.state.dailyScalps = 0;
            this.state.dailyProfit = 0;
            this.state.lastResetDate = today;
        }
        await this._acquireScalpsLock();
        try {
            const now = Date.now();
            const before = this.state.activeScalps.length;
            this.state.activeScalps = this.state.activeScalps.filter(s => {
                const age = now - new Date(s.time).getTime();
                return age < CONFIG.SCALP_TIMEOUT;
            });
            const cleaned = before - this.state.activeScalps.length;
            if (cleaned > 0) log.warn(`${cleaned} scalps périmés nettoyés`);
        } finally {
            this._releaseScalpsLock();
        }
    }

    /**
     * Cycle de scalping:
     * 1. Rafraîchir l'orderbook du marché cible
     * 2. Sélectionner le meilleur token (Yes/No) automatiquement
     * 3. Exécuter le scalp (buy + sell à +0.01)
     */
    async _executeScalpCycle() {
        if (this.state.dailyProfit < -CONFIG.MAX_DAILY_LOSS) {
            log.error(`STOP-LOSS: perte journalière $${Math.abs(this.state.dailyProfit).toFixed(2)} > max $${CONFIG.MAX_DAILY_LOSS}`);
            this.stop();
            return;
        }

        if (this.state.dailyVolume >= CONFIG.DAILY_VOLUME_TARGET) {
            log.info(`Volume cible atteint: $${this.state.dailyVolume.toFixed(0)} / $${CONFIG.DAILY_VOLUME_TARGET}`);
            return;
        }

        if (!this.targetMarket) {
            log.warn('Aucun marché cible défini');
            return;
        }

        log.info(`=== Cycle #${this.state.totalCycles + 1} | Vol: $${this.state.dailyVolume.toFixed(0)}/$${CONFIG.DAILY_VOLUME_TARGET} | Scalps: ${this.state.dailyScalps} ===`);

        // 1. Rafraîchir les orderbooks du marché cible
        const m = this.targetMarket;
        const [yesBook, noBook] = await Promise.all([
            m.yesTokenId ? this.poly.analyzeBookForScalp(m.yesTokenId) : null,
            m.noTokenId ? this.poly.analyzeBookForScalp(m.noTokenId) : null,
        ]);

        // 2. Choisir le meilleur token automatiquement
        const candidates = [];
        if (yesBook && yesBook.spreadCents > 0 && yesBook.spreadCents <= CONFIG.MAX_SPREAD_CENTS
            && yesBook.bidDepthUsd >= CONFIG.MIN_BOOK_DEPTH_USD && yesBook.askDepthUsd >= CONFIG.MIN_BOOK_DEPTH_USD) {
            candidates.push({ token: 'yes', tokenId: m.yesTokenId, book: yesBook });
        }
        if (noBook && noBook.spreadCents > 0 && noBook.spreadCents <= CONFIG.MAX_SPREAD_CENTS
            && noBook.bidDepthUsd >= CONFIG.MIN_BOOK_DEPTH_USD && noBook.askDepthUsd >= CONFIG.MIN_BOOK_DEPTH_USD) {
            candidates.push({ token: 'no', tokenId: m.noTokenId, book: noBook });
        }

        if (candidates.length === 0) {
            log.info(`Pas de token scalable (spread > ${CONFIG.MAX_SPREAD_CENTS}c ou liquidité insuffisante)`);
            return;
        }

        // Trier par meilleur bidDepth (plus de liquidité = meilleur pour scalper)
        candidates.sort((a, b) => b.book.bidDepthUsd - a.book.bidDepthUsd);
        const best = candidates[0];

        const target = {
            tokenId: best.tokenId,
            buyPrice: best.book.bestBid,
            sellPrice: +(best.book.bestBid + CONFIG.SCALP_TICK).toFixed(2),
            sizeUsd: CONFIG.TRADE_SIZE_USD,
            market: `${m.question} (${best.token.toUpperCase()})`,
        };

        log.info(`Target: ${best.token.toUpperCase()} | Bid: ${best.book.bestBid} | Spread: ${best.book.spreadCents}c | Depth: $${best.book.bidDepthUsd.toFixed(0)}`);

        // 3. Exécuter le scalp
        await this._executeScalp(target);
    }

    async _executeScalp(target) {
        const { tokenId, buyPrice, sellPrice, sizeUsd, market } = target;

        if (!tokenId || !buyPrice || !sellPrice) {
            log.warn('Target invalide:', target);
            return;
        }

        const priceDiff = +(sellPrice - buyPrice).toFixed(4);
        if (Math.abs(priceDiff - CONFIG.SCALP_TICK) > 0.005) {
            log.warn(`Tick invalide: buy=${buyPrice} sell=${sellPrice} diff=${priceDiff}`);
            return;
        }

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
        if (!freshBook) {
            log.warn('Scalp annulé: orderbook indisponible');
            return;
        }
        if (freshBook.spreadCents <= 0) {
            log.warn('Scalp annulé: spread nul');
            return;
        }
        if (freshBook.spreadCents > CONFIG.MAX_SPREAD_CENTS) {
            log.warn(`Scalp annulé: spread ${freshBook.spreadCents}c > max ${CONFIG.MAX_SPREAD_CENTS}c`);
            return;
        }
        if (freshBook.bidDepthUsd < CONFIG.MIN_BOOK_DEPTH_USD) {
            log.warn(`Scalp annulé: bid depth faible $${freshBook.bidDepthUsd.toFixed(0)}`);
            return;
        }

        // Ajuster le prix si le book a bougé
        let finalBuyPrice = buyPrice;
        let finalSellPrice = sellPrice;
        if (freshBook.bestBid !== buyPrice) {
            finalBuyPrice = freshBook.bestBid;
            finalSellPrice = +(freshBook.bestBid + CONFIG.SCALP_TICK).toFixed(2);
            log.trade(`Prix ajusté: buy=${finalBuyPrice} sell=${finalSellPrice}`);
        }

        if (finalSellPrice > freshBook.bestAsk) {
            log.warn(`Sell ${finalSellPrice} > bestAsk ${freshBook.bestAsk} - skip`);
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

            // === Vérification du fill ===
            const fillResult = await this.poly.waitForFill(buyResult.id, 10000, 1000);

            if (!fillResult.filled) {
                log.warn(`Buy non rempli après 10s (status: ${fillResult.status}) - annulation`);
                try {
                    await this.poly.cancelOrder(buyResult.id);
                    log.trade('Buy annulé: ' + buyResult.id);
                } catch (cancelErr) {
                    log.error('Erreur annulation buy:', cancelErr.message);
                }
                this.stats.failedScalps++;
                return;
            }

            const filledShares = fillResult.fullyFilled ? shares : +fillResult.sizeMatched.toFixed(2);
            if (filledShares < 1) {
                log.warn(`Fill trop petit: ${filledShares} shares - skip sell`);
                this.stats.failedScalps++;
                return;
            }

            log.trade(`Buy filled: ${filledShares}/${shares} shares (${fillResult.status})`);

            // === ÉTAPE 2: SELL à +0.01 ===
            const sellShares = filledShares;
            const sellResult = await this.poly.placeOrder({
                tokenId,
                side: 'sell',
                price: finalSellPrice,
                size: sellShares,
            });

            if (!sellResult) {
                log.error('Sell échoué - position ouverte!');
                await this._acquireScalpsLock();
                try {
                    this.state.activeScalps.push({
                        market,
                        tokenId,
                        buyPrice: finalBuyPrice,
                        sellPrice: finalSellPrice,
                        shares,
                        buyOrderId: buyResult.id,
                        time: new Date().toISOString(),
                    });
                } finally {
                    this._releaseScalpsLock();
                }
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
            targetMarket: this.targetMarket?.question || 'Aucun',
            dailyVolume: this.state.dailyVolume,
            dailyTarget: CONFIG.DAILY_VOLUME_TARGET,
            dailyProgress: ((this.state.dailyVolume / CONFIG.DAILY_VOLUME_TARGET) * 100).toFixed(1),
            dailyScalps: this.state.dailyScalps,
            dailyProfit: this.state.dailyProfit,
            activeScalps: this.state.activeScalps.length,
            totalCycles: this.state.totalCycles,
            scalpTick: CONFIG.SCALP_TICK,
            tradeSize: CONFIG.TRADE_SIZE_USD,
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
