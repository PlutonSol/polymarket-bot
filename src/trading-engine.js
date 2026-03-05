const { CONFIG } = require('./config');
const log = require('./logger');

/**
 * Moteur de trading - Gère l'exécution des trades, le risk management et le suivi du volume
 */
class TradingEngine {
    constructor(polyClient, llmAnalyzer) {
        this.poly = polyClient;
        this.llm = llmAnalyzer;
        this.isRunning = false;
        this.tradingLoop = null;

        // État du trading
        this.state = {
            dailyVolume: 0,
            dailyTrades: [],
            dailyPnL: 0,
            openPositions: new Map(), // tokenId -> { side, size, avgPrice }
            pendingOrders: new Map(), // orderId -> order
            lastResetDate: new Date().toDateString(),
            totalCycles: 0,
        };

        // Stats
        this.stats = {
            totalTrades: 0,
            totalVolume: 0,
            successfulTrades: 0,
            failedTrades: 0,
            llmCalls: 0,
        };
    }

    /**
     * Démarre la boucle de trading automatique
     */
    async start() {
        if (this.isRunning) return 'Déjà en cours';
        this.isRunning = true;
        log.info('Démarrage du moteur de trading');
        this._runLoop();
        return 'Moteur de trading démarré';
    }

    /**
     * Arrête la boucle de trading
     */
    stop() {
        this.isRunning = false;
        if (this.tradingLoop) {
            clearTimeout(this.tradingLoop);
            this.tradingLoop = null;
        }
        log.info('Moteur de trading arrêté');
        return 'Moteur de trading arrêté';
    }

    /**
     * Boucle principale de trading
     */
    async _runLoop() {
        while (this.isRunning) {
            try {
                this._checkDayReset();
                await this._executeTradingCycle();
                this.state.totalCycles++;
            } catch (error) {
                log.error('Erreur cycle trading:', error.message);
            }

            if (this.isRunning) {
                await new Promise(r => {
                    this.tradingLoop = setTimeout(r, CONFIG.TRADING_INTERVAL);
                });
            }
        }
    }

    /**
     * Reset les stats quotidiennes si nouveau jour
     */
    _checkDayReset() {
        const today = new Date().toDateString();
        if (today !== this.state.lastResetDate) {
            log.info('Nouveau jour - reset des stats quotidiennes');
            this.state.dailyVolume = 0;
            this.state.dailyTrades = [];
            this.state.dailyPnL = 0;
            this.state.lastResetDate = today;
        }
    }

    /**
     * Exécute un cycle de trading complet
     */
    async _executeTradingCycle() {
        // Vérifier si le volume cible est atteint
        if (this.state.dailyVolume >= CONFIG.DAILY_VOLUME_TARGET) {
            log.info(`Volume cible atteint: $${this.state.dailyVolume.toFixed(2)} / $${CONFIG.DAILY_VOLUME_TARGET}`);
            return;
        }

        log.info(`=== Cycle #${this.state.totalCycles + 1} | Volume: $${this.state.dailyVolume.toFixed(2)} / $${CONFIG.DAILY_VOLUME_TARGET} ===`);

        // 1. Récupérer les marchés actifs
        const markets = await this.poly.getCachedMarkets(30);
        if (markets.length === 0) {
            log.warn('Aucun marché actif trouvé');
            return;
        }

        // 2. Enrichir avec les données de prix (en parallèle, limité à 10)
        const marketsToEnrich = markets.slice(0, 10);
        const enriched = (await Promise.all(
            marketsToEnrich.map(m => this.poly.enrichMarketData(m).catch(() => null))
        )).filter(Boolean);

        if (enriched.length === 0) {
            log.warn('Aucune donnée de prix disponible');
            return;
        }

        // 3. Demander au LLM une stratégie de volume
        this.stats.llmCalls++;
        const strategy = await this.llm.generateVolumeStrategy(
            enriched,
            this.state.dailyVolume,
            CONFIG.DAILY_VOLUME_TARGET
        );

        if (!strategy || !strategy.trades || strategy.trades.length === 0) {
            log.warn('LLM n\'a proposé aucun trade');
            return;
        }

        log.info(`Stratégie: ${strategy.strategy || 'N/A'} - ${strategy.trades.length} trades proposés`);

        // 4. Exécuter les trades
        for (const trade of strategy.trades) {
            if (!this.isRunning) break;
            if (this.state.dailyVolume >= CONFIG.DAILY_VOLUME_TARGET) break;

            await this._executeTrade(trade);

            // Pause entre les trades pour éviter le rate limiting
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    /**
     * Exécute un trade individuel avec validation
     */
    async _executeTrade(trade) {
        try {
            // Validation de base
            if (!trade.tokenId || !trade.side || !trade.price || !trade.size) {
                log.warn('Trade invalide - champs manquants:', trade);
                return null;
            }

            const tradeSize = parseFloat(trade.size);
            const tradePrice = parseFloat(trade.price);

            // Vérifier les limites
            if (tradeSize < CONFIG.MIN_TRADE_SIZE) {
                log.warn(`Trade trop petit: $${tradeSize}`);
                return null;
            }
            if (tradeSize > CONFIG.MAX_TRADE_SIZE) {
                trade.size = CONFIG.MAX_TRADE_SIZE;
                log.warn(`Trade réduit à max: $${CONFIG.MAX_TRADE_SIZE}`);
            }

            // Vérifier que le prix est raisonnable (entre 0.01 et 0.99)
            if (tradePrice < 0.01 || tradePrice > 0.99) {
                log.warn(`Prix invalide: ${tradePrice}`);
                return null;
            }

            // Vérifier le nombre de positions ouvertes
            if (this.state.openPositions.size >= CONFIG.MAX_OPEN_POSITIONS && trade.type === 'entry') {
                log.warn('Max positions atteint');
                return null;
            }

            // Calculer la taille en shares
            const shares = tradeSize / tradePrice;

            log.trade(`Exécution: ${trade.side.toUpperCase()} ${shares.toFixed(2)} shares @ ${tradePrice} ($${tradeSize.toFixed(2)}) - ${trade.marketTitle || 'N/A'}`);

            // Placer l'ordre
            const result = await this.poly.placeOrder({
                tokenId: trade.tokenId,
                side: trade.side,
                price: tradePrice,
                size: shares,
            });

            if (result) {
                const volume = tradeSize;
                this.state.dailyVolume += volume;
                this.state.dailyTrades.push({
                    ...trade,
                    orderId: result.id,
                    executedAt: new Date().toISOString(),
                    volume,
                });
                this.stats.totalTrades++;
                this.stats.totalVolume += volume;
                this.stats.successfulTrades++;

                // Mettre à jour les positions
                this._updatePosition(trade);

                log.trade(`Succès - Volume journalier: $${this.state.dailyVolume.toFixed(2)}`);
                return result;
            }
        } catch (error) {
            log.error(`Erreur trade:`, error.message);
            this.stats.failedTrades++;
        }
        return null;
    }

    /**
     * Met à jour le suivi des positions
     */
    _updatePosition(trade) {
        const key = trade.tokenId;
        const existing = this.state.openPositions.get(key);

        if (trade.type === 'exit' && existing) {
            this.state.openPositions.delete(key);
            return;
        }

        if (trade.side === 'buy') {
            if (existing && existing.side === 'buy') {
                // Augmenter la position
                const totalSize = existing.size + parseFloat(trade.size);
                const avgPrice = (existing.avgPrice * existing.size + parseFloat(trade.price) * parseFloat(trade.size)) / totalSize;
                this.state.openPositions.set(key, { side: 'buy', size: totalSize, avgPrice });
            } else if (existing && existing.side === 'sell') {
                // Réduire la position short
                const remaining = existing.size - parseFloat(trade.size);
                if (remaining <= 0) {
                    this.state.openPositions.delete(key);
                } else {
                    this.state.openPositions.set(key, { ...existing, size: remaining });
                }
            } else {
                this.state.openPositions.set(key, {
                    side: 'buy',
                    size: parseFloat(trade.size),
                    avgPrice: parseFloat(trade.price),
                });
            }
        } else {
            if (existing && existing.side === 'buy') {
                const remaining = existing.size - parseFloat(trade.size);
                if (remaining <= 0) {
                    this.state.openPositions.delete(key);
                } else {
                    this.state.openPositions.set(key, { ...existing, size: remaining });
                }
            } else {
                this.state.openPositions.set(key, {
                    side: 'sell',
                    size: parseFloat(trade.size),
                    avgPrice: parseFloat(trade.price),
                });
            }
        }
    }

    /**
     * Exécute un trade manuel (appelé depuis Telegram)
     */
    async manualTrade({ tokenId, side, price, size, marketTitle }) {
        this._checkDayReset();
        return await this._executeTrade({
            tokenId,
            side,
            price,
            size,
            marketTitle,
            type: 'manual',
        });
    }

    /**
     * Retourne le statut actuel du moteur
     */
    getStatus() {
        return {
            isRunning: this.isRunning,
            mode: CONFIG.DRY_RUN ? 'DRY RUN' : 'LIVE',
            dailyVolume: this.state.dailyVolume,
            dailyTarget: CONFIG.DAILY_VOLUME_TARGET,
            dailyProgress: ((this.state.dailyVolume / CONFIG.DAILY_VOLUME_TARGET) * 100).toFixed(1),
            dailyTradeCount: this.state.dailyTrades.length,
            openPositions: this.state.openPositions.size,
            totalCycles: this.state.totalCycles,
            stats: { ...this.stats },
        };
    }

    /**
     * Retourne les trades du jour
     */
    getDailyTrades() {
        return this.state.dailyTrades;
    }

    /**
     * Retourne les positions ouvertes
     */
    getOpenPositions() {
        return Object.fromEntries(this.state.openPositions);
    }
}

module.exports = TradingEngine;
