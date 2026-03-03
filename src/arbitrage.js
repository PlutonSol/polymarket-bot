const { ethers } = require('ethers');
const CONFIG = require('./config');
const HyperliquidClient = require('./hyperliquid');
const HyperEvmClient = require('./hyperEvm');

/**
 * Moteur d'arbitrage HYPE sub-2s.
 *
 * Timeline par bloc:
 * ┌─────────────────────────────────────────────────────────┐
 * │ Block N arrive (WebSocket)                    t = 0ms   │
 * │                                                         │
 * │ ┌─ HL L2 book (HTTP POST) ──────────────┐              │
 * │ │                              ~80ms     │  parallèle   │
 * │ ├─ EVM getReserves (RPC) ───────────────┤              │
 * │ │                              ~80ms     │              │
 * │ └───────────────────────────────────────┘   t = 80ms   │
 * │                                                         │
 * │ AMM math locale (CPU)                       t = 80.1ms │
 * │ Évaluation opportunité                      t = 80.2ms │
 * │                                                         │
 * │ ┌─ fireSwap (1 RPC: sendRawTx) ────────┐              │
 * │ │                              ~100ms   │  parallèle   │
 * │ ├─ HL order (sign + HTTP POST) ────────┤              │
 * │ │                              ~100ms   │              │
 * │ └──────────────────────────────────────┘   t = 180ms  │
 * │                                                         │
 * │ ✅ Total: ~180ms  (budget: 2000ms)                      │
 * │                                                         │
 * │ ...background: track TX confirmation...                 │
 * └─────────────────────────────────────────────────────────┘
 */
class ArbitrageEngine {
    constructor(telegram) {
        this.hl = new HyperliquidClient();
        this.evm = new HyperEvmClient();
        this.telegram = telegram;
        this.isRunning = false;
        this.isExecuting = false;
        this.circuitBroken = false;
        this.lastBlockNumber = 0;
        this.stats = {
            scans: 0,
            opportunities: 0,
            trades: 0,
            confirmedTrades: 0,
            revertedTrades: 0,
            totalProfit: 0,
            totalLoss: 0,
            errors: 0,
            startTime: null,
            avgScanMs: 0,
            avgExecMs: 0,
            lastScanMs: 0,
            lastExecMs: 0,
        };
        this.lastOpportunities = [];
        this.tradeTimestamps = [];
    }

    async warmup() {
        console.log('[ARB] Warming up...');
        await this.evm.warmup();
        await Promise.all([
            this.evm.preApproveTokens(),
            this.hl.getSpotMeta(),
        ]);
        console.log('[ARB] Warmup complete');
    }

    /**
     * Démarre le moteur en mode block-aligned.
     * Au lieu de poll toutes les Xms, on réagit à chaque nouveau bloc.
     */
    async start() {
        this.isRunning = true;
        this.circuitBroken = false;
        this.stats.startTime = Date.now();

        console.log('\n[ARB] Engine started - HYPE only (block-aligned)');
        console.log(`[ARB] Min spread: ${CONFIG.MIN_SPREAD_PCT}%`);
        console.log(`[ARB] Trade size: $${CONFIG.TRADE_SIZE_USDC}`);
        console.log(`[ARB] Max loss: $${CONFIG.MAX_LOSS_USD}`);
        console.log(`[ARB] Mode: ${CONFIG.DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

        await this.warmup();

        // S'abonner aux blocs: scan déclenché à chaque bloc
        this.evm.onNewBlock((blockNumber) => {
            if (!this.isRunning) return;
            if (blockNumber <= this.lastBlockNumber) return;
            this.lastBlockNumber = blockNumber;
            this._onBlock(blockNumber);
        });

        console.log('[ARB] Listening for new blocks...');
    }

    stop() {
        this.isRunning = false;
        this.evm.destroy().catch(() => {});
        console.log('[ARB] Engine stopped');
    }

    /**
     * Callback appelé à chaque nouveau bloc.
     * Exécute scan + trade + check pending en séquence rapide.
     */
    async _onBlock(blockNumber) {
        if (this.circuitBroken) return;

        const scanStart = Date.now();

        try {
            // 1) Check pending TXs en arrière-plan (non-bloquant pour le scan)
            this.evm.checkPendingTxs().then(results => {
                this._processTxResults(results);
            }).catch(() => {});

            // 2) Refresh gas price en arrière-plan (cache 10s)
            this.evm.refreshGasPrice().catch(() => {});

            // 3) Scan principal
            this.stats.scans++;
            const opportunity = await this.checkArbitrage();

            const scanMs = Date.now() - scanStart;
            this.stats.lastScanMs = scanMs;
            this.stats.avgScanMs = this.stats.avgScanMs
                ? (this.stats.avgScanMs * 0.9 + scanMs * 0.1)
                : scanMs;

            if (opportunity) {
                this.stats.opportunities++;
                this.lastOpportunities.unshift(opportunity);
                if (this.lastOpportunities.length > 50) this.lastOpportunities.pop();
                await this.handleOpportunity(opportunity);
            }

            if (CONFIG.LOG_LEVEL === 'debug' || this.stats.scans % 100 === 0) {
                console.log(`[#${blockNumber}] Scan: ${scanMs}ms | Opps: ${this.stats.opportunities} | Trades: ${this.stats.trades} (${this.stats.confirmedTrades}ok/${this.stats.revertedTrades}fail) | Pending: ${this.evm.pendingTxs.length}`);
            }
        } catch (e) {
            this.stats.errors++;
            console.error(`[ARB] Block ${blockNumber} error:`, e.message);
        }
    }

    /**
     * Check arbitrage HYPE.
     * 2 appels parallèles + AMM math locale = ~80ms total.
     */
    async checkArbitrage() {
        // 2 appels en parallèle: HL orderbook + EVM reserves
        const [hlData, evmData] = await Promise.all([
            this.hl.getHypeBestBidAsk(),
            this.evm.getHypePrice(),
        ]);

        if (!hlData || !hlData.bestBid || !hlData.bestAsk) return null;
        if (!evmData) return null;

        const hlMid = (hlData.bestBid + hlData.bestAsk) / 2;
        const evmPrice = evmData.price;
        const spread = ((evmPrice - hlMid) / hlMid) * 100;
        const absSpread = Math.abs(spread);

        if (absSpread < CONFIG.MIN_SPREAD_PCT) return null;

        // AMM math LOCALE: 0 appel RPC
        const direction = spread > 0 ? 'sell' : 'buy';
        const effectiveData = this.evm.computeEffectivePrice(
            CONFIG.TRADE_SIZE_USDC,
            evmData,
            direction,
        );

        const gasData = this.evm.cachedGasPrice || { gasPriceGwei: 1 };
        const estimatedGasCost = gasData.gasPriceGwei * CONFIG.FIXED_GAS_LIMIT / 1e9;

        let buyPrice, sellPrice, buyVenue, sellVenue, arbDirection;

        if (spread > 0) {
            arbDirection = 'BUY_HL_SELL_EVM';
            buyPrice = hlData.bestAsk;
            sellPrice = effectiveData.effectivePrice;
            buyVenue = 'Hyperliquid';
            sellVenue = 'HyperEVM';
        } else {
            arbDirection = 'BUY_EVM_SELL_HL';
            buyPrice = effectiveData.effectivePrice;
            sellPrice = hlData.bestBid;
            buyVenue = 'HyperEVM';
            sellVenue = 'Hyperliquid';
        }

        const tokenAmount = CONFIG.TRADE_SIZE_USDC / buyPrice;
        const grossProfit = (sellPrice - buyPrice) * tokenAmount;
        const netProfit = grossProfit - estimatedGasCost;

        const availableSize = arbDirection === 'BUY_HL_SELL_EVM'
            ? hlData.askSize
            : evmData.hypeReserve;
        const hasLiquidity = availableSize >= tokenAmount * 1.1;

        return {
            timestamp: new Date().toISOString(),
            token: 'HYPE',
            direction: arbDirection,
            buyVenue,
            sellVenue,
            hlBid: hlData.bestBid,
            hlAsk: hlData.bestAsk,
            hlMid,
            evmPrice,
            buyPrice,
            sellPrice,
            spread: absSpread,
            tokenAmount,
            tradeSize: CONFIG.TRADE_SIZE_USDC,
            grossProfit,
            gasCost: estimatedGasCost,
            netProfit,
            evmLiquidity: evmData.liquidity,
            hasLiquidity,
            priceImpact: effectiveData.priceImpact,
            profitable: netProfit > 0 && hasLiquidity,
            // Garder les réserves pour l'exécution
            _reserves: evmData,
        };
    }

    async handleOpportunity(opp) {
        console.log(`${opp.profitable ? '💰' : '👀'} HYPE ${opp.direction} | Spread: ${opp.spread.toFixed(3)}% | Net: $${opp.netProfit.toFixed(4)}`);

        this.telegram.sendOpportunity(opp).catch(() => {});

        if (opp.profitable && !CONFIG.DRY_RUN) {
            await this.executeArbitrage(opp);
        } else if (opp.profitable && CONFIG.DRY_RUN) {
            console.log(`  [DRY-RUN] $${opp.netProfit.toFixed(4)} profit`);
        }
    }

    /**
     * Exécution fire-and-forget.
     * Envoie EVM TX + HL order en parallèle (~100ms).
     * N'attend PAS la confirmation de la TX EVM.
     */
    async executeArbitrage(opp) {
        if (this.isExecuting) return;

        // Circuit breaker
        if (this.stats.totalLoss > CONFIG.MAX_LOSS_USD) {
            if (!this.circuitBroken) {
                this.circuitBroken = true;
                console.error(`[ARB] CIRCUIT BREAKER: loss $${this.stats.totalLoss.toFixed(2)}`);
                this.telegram.sendError(`CIRCUIT BREAKER: loss $${this.stats.totalLoss.toFixed(2)}`).catch(() => {});
            }
            return;
        }

        // Rate limiting
        const oneHourAgo = Date.now() - 3600000;
        this.tradeTimestamps = this.tradeTimestamps.filter(t => t > oneHourAgo);
        if (this.tradeTimestamps.length >= CONFIG.MAX_TRADES_PER_HOUR) return;

        // Slippage check
        if (opp.priceImpact > CONFIG.MAX_SLIPPAGE_PCT) return;

        this.isExecuting = true;
        const execStart = Date.now();

        try {
            let hlPromise, evmPromise;

            if (opp.direction === 'BUY_EVM_SELL_HL') {
                const amountIn = ethers.parseUnits(opp.tradeSize.toString(), this.evm.usdcDecimals);
                const minOut = ethers.parseUnits(
                    (opp.tokenAmount * (1 - CONFIG.MAX_SLIPPAGE_PCT / 100)).toFixed(8),
                    18
                );
                evmPromise = this.evm.fireSwap(amountIn, minOut, this.evm.pathBuyHype);
                hlPromise = this.hl.placeSpotOrder({
                    isBuy: false,
                    size: opp.tokenAmount,
                    price: opp.hlBid,
                });
            } else {
                const amountIn = ethers.parseUnits(opp.tokenAmount.toFixed(8), 18);
                const minOut = ethers.parseUnits(
                    (opp.tradeSize * (1 - CONFIG.MAX_SLIPPAGE_PCT / 100)).toFixed(6),
                    this.evm.usdcDecimals
                );
                hlPromise = this.hl.placeSpotOrder({
                    isBuy: true,
                    size: opp.tokenAmount,
                    price: opp.hlAsk,
                });
                evmPromise = this.evm.fireSwap(amountIn, minOut, this.evm.pathSellHype);
            }

            // Les deux en parallèle - retourne dès que les deux sont ENVOYÉS
            const [evmResult, hlResult] = await Promise.all([evmPromise, hlPromise]);

            const execMs = Date.now() - execStart;
            this.stats.trades++;
            this.tradeTimestamps.push(Date.now());

            if (opp.netProfit >= 0) {
                this.stats.totalProfit += opp.netProfit;
            } else {
                this.stats.totalLoss += Math.abs(opp.netProfit);
            }

            this.stats.lastExecMs = execMs;
            this.stats.avgExecMs = this.stats.avgExecMs
                ? (this.stats.avgExecMs * 0.9 + execMs * 0.1)
                : execMs;

            console.log(`🔥 Executed in ${execMs}ms | TX: ${evmResult.txHash?.slice(0, 10) || 'dry-run'}...`);
            this.telegram.sendTradeExecution(opp, { evmResult, hlResult, execMs }).catch(() => {});

        } catch (e) {
            this.stats.errors++;
            console.error(`❌ Exec failed (${Date.now() - execStart}ms):`, e.message);
            this.telegram.sendError(`Exec: ${e.message}`).catch(() => {});
            await this.evm.resyncNonce();
        } finally {
            this.isExecuting = false;
        }
    }

    /**
     * Traite les résultats de confirmation des TX en arrière-plan.
     */
    _processTxResults(results) {
        for (const r of results) {
            if (r.confirmed) {
                this.stats.confirmedTrades++;
            } else {
                this.stats.revertedTrades++;
                this.stats.totalLoss += 0.5; // Coût du gas perdu
                this.evm.resyncNonce().catch(() => {});
            }
        }
    }

    getStats() {
        const uptime = this.stats.startTime
            ? Math.floor((Date.now() - this.stats.startTime) / 1000)
            : 0;

        return {
            ...this.stats,
            uptime,
            uptimeStr: this._formatDuration(uptime),
            avgProfitPerTrade: this.stats.trades > 0
                ? this.stats.totalProfit / this.stats.trades : 0,
            successRate: this.stats.scans > 0
                ? ((this.stats.opportunities / this.stats.scans) * 100).toFixed(2) + '%' : '0%',
            circuitBroken: this.circuitBroken,
            tradesLastHour: this.tradeTimestamps.filter(t => t > Date.now() - 3600000).length,
            pendingTxs: this.evm.pendingTxs.length,
        };
    }

    getRecentOpportunities(count = 5) {
        return this.lastOpportunities.slice(0, count);
    }

    resetCircuitBreaker() {
        this.circuitBroken = false;
        this.stats.totalLoss = 0;
    }

    _formatDuration(s) {
        return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
    }
}

module.exports = ArbitrageEngine;
