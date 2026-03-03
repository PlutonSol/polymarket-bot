const { ethers } = require('ethers');
const CONFIG = require('./config');
const HyperliquidClient = require('./hyperliquid');
const HyperEvmClient = require('./hyperEvm');

/**
 * Moteur d'arbitrage HYPE: Hyperliquid L1 (spot) <-> HyperEVM (DEX AMM)
 *
 * Optimisé pour un seul token (HYPE):
 * - Pas de boucle multi-token, appels directs
 * - Prix HL + EVM en parallèle (2 appels RPC simultanés)
 * - Buy + Sell en parallèle
 * - Nonce management pour TX EVM parallèles
 * - Circuit breaker: max loss + max trades/heure
 * - Validation des balances avant exécution
 */
class ArbitrageEngine {
    constructor(telegram) {
        this.hl = new HyperliquidClient();
        this.evm = new HyperEvmClient();
        this.telegram = telegram;
        this.isRunning = false;
        this.isExecuting = false;
        this.circuitBroken = false;
        this.stats = {
            scans: 0,
            opportunities: 0,
            trades: 0,
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
        // Rate limiting: timestamps des trades récents
        this.tradeTimestamps = [];
    }

    async warmup() {
        console.log('[ARB] Warming up...');
        await Promise.all([
            this.evm.warmup(),
            this.evm.preApproveTokens(),
            this.hl.getSpotMeta(),
        ]);
        console.log('[ARB] Warmup complete');
    }

    async start() {
        this.isRunning = true;
        this.circuitBroken = false;
        this.stats.startTime = Date.now();

        console.log(`\n[ARB] Engine started - HYPE only`);
        console.log(`[ARB] Scan interval: ${CONFIG.SCAN_INTERVAL_MS}ms`);
        console.log(`[ARB] Min spread: ${CONFIG.MIN_SPREAD_PCT}%`);
        console.log(`[ARB] Trade size: $${CONFIG.TRADE_SIZE_USDC}`);
        console.log(`[ARB] Max loss: $${CONFIG.MAX_LOSS_USD}`);
        console.log(`[ARB] Max trades/h: ${CONFIG.MAX_TRADES_PER_HOUR}`);
        console.log(`[ARB] Mode: ${CONFIG.DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

        await this.warmup();

        while (this.isRunning) {
            if (this.circuitBroken) {
                await this._sleep(10000); // Ralentir quand le circuit breaker est actif
                continue;
            }
            try {
                await this.scan();
            } catch (e) {
                this.stats.errors++;
                console.error('[ARB] Scan error:', e.message);
            }
            await this._sleep(CONFIG.SCAN_INTERVAL_MS);
        }
    }

    stop() {
        this.isRunning = false;
        console.log('[ARB] Engine stopped');
    }

    /**
     * Scan HYPE uniquement. Pas de boucle, appels directs.
     */
    async scan() {
        this.stats.scans++;
        const scanStart = Date.now();

        const opportunity = await this.checkArbitrage();

        if (opportunity) {
            this.stats.opportunities++;
            this.lastOpportunities.unshift(opportunity);
            if (this.lastOpportunities.length > 50) this.lastOpportunities.pop();
            await this.handleOpportunity(opportunity);
        }

        const scanMs = Date.now() - scanStart;
        this.stats.lastScanMs = scanMs;
        this.stats.avgScanMs = this.stats.avgScanMs
            ? (this.stats.avgScanMs * 0.9 + scanMs * 0.1)
            : scanMs;

        if (this.stats.scans % 200 === 0) {
            console.log(`[ARB] Scans: ${this.stats.scans} | Opps: ${this.stats.opportunities} | Trades: ${this.stats.trades} | Avg: ${this.stats.avgScanMs.toFixed(0)}ms`);
        }
    }

    /**
     * Check arbitrage HYPE: prix HL + EVM récupérés en parallèle.
     */
    async checkArbitrage() {
        // 2 appels en parallèle: orderbook HL + reserves EVM + gas cache
        const [hlData, evmData, gasData] = await Promise.all([
            this.hl.getHypeBestBidAsk(),
            this.evm.getHypePrice(),
            this.evm.getGasPrice(),
        ]);

        if (!hlData || !hlData.bestBid || !hlData.bestAsk) return null;
        if (!evmData) return null;

        const hlMid = (hlData.bestBid + hlData.bestAsk) / 2;
        const evmPrice = evmData.price;
        const spread = ((evmPrice - hlMid) / hlMid) * 100;
        const absSpread = Math.abs(spread);

        if (CONFIG.LOG_LEVEL === 'debug') {
            console.log(`[ARB] HYPE: HL=$${hlMid.toFixed(4)} EVM=$${evmPrice.toFixed(4)} Spread=${spread.toFixed(3)}%`);
        }

        if (absSpread < CONFIG.MIN_SPREAD_PCT) return null;

        // Prix effectif avec slippage (passe les réserves pour éviter un 2e appel)
        const direction = spread > 0 ? 'sell' : 'buy';
        const effectiveData = await this.evm.getEffectivePrice(
            CONFIG.TRADE_SIZE_USDC,
            direction,
            evmData
        );

        const estimatedGasCost = gasData.gasPriceGwei * 250000 / 1e9;

        let buyPrice, sellPrice, buyVenue, sellVenue, arbDirection;

        if (spread > 0) {
            // EVM plus cher → acheter HL, vendre EVM
            arbDirection = 'BUY_HL_SELL_EVM';
            buyPrice = hlData.bestAsk;
            sellPrice = effectiveData ? effectiveData.effectivePrice : evmPrice;
            buyVenue = 'Hyperliquid';
            sellVenue = 'HyperEVM';
        } else {
            // HL plus cher → acheter EVM, vendre HL
            arbDirection = 'BUY_EVM_SELL_HL';
            buyPrice = effectiveData ? effectiveData.effectivePrice : evmPrice;
            sellPrice = hlData.bestBid;
            buyVenue = 'HyperEVM';
            sellVenue = 'Hyperliquid';
        }

        const tokenAmount = CONFIG.TRADE_SIZE_USDC / buyPrice;
        const grossProfit = (sellPrice - buyPrice) * tokenAmount;
        const netProfit = grossProfit - estimatedGasCost;
        const netSpreadPct = (netProfit / CONFIG.TRADE_SIZE_USDC) * 100;

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
            netSpread: netSpreadPct,
            tokenAmount,
            tradeSize: CONFIG.TRADE_SIZE_USDC,
            grossProfit,
            gasCost: estimatedGasCost,
            netProfit,
            evmLiquidity: evmData.liquidity,
            hasLiquidity,
            priceImpact: effectiveData ? effectiveData.priceImpact : 0,
            profitable: netProfit > 0 && hasLiquidity,
        };
    }

    async handleOpportunity(opp) {
        console.log(`\n${opp.profitable ? '💰' : '👀'} [ARB] HYPE ${opp.direction}`);
        console.log(`  Buy $${opp.buyPrice.toFixed(4)} (${opp.buyVenue}) → Sell $${opp.sellPrice.toFixed(4)} (${opp.sellVenue})`);
        console.log(`  Spread: ${opp.spread.toFixed(3)}% | Net: $${opp.netProfit.toFixed(4)}`);

        // Telegram non-bloquant
        this.telegram.sendOpportunity(opp).catch(() => {});

        if (opp.profitable && !CONFIG.DRY_RUN) {
            await this.executeArbitrage(opp);
        } else if (opp.profitable && CONFIG.DRY_RUN) {
            console.log(`  [DRY-RUN] Would trade for $${opp.netProfit.toFixed(4)} profit`);
        }
    }

    /**
     * Exécute l'arbitrage avec toutes les protections:
     * - Verrou anti-concurrence
     * - Circuit breaker (max loss)
     * - Rate limiting (max trades/heure)
     * - Validation du slippage
     * - Buy + Sell en parallèle
     * - Nonce management
     */
    async executeArbitrage(opp) {
        if (this.isExecuting) {
            console.log('[ARB] Already executing, skip');
            return;
        }

        // Circuit breaker check
        if (this.stats.totalLoss > CONFIG.MAX_LOSS_USD) {
            if (!this.circuitBroken) {
                this.circuitBroken = true;
                console.error(`[ARB] CIRCUIT BREAKER: loss $${this.stats.totalLoss.toFixed(2)} > max $${CONFIG.MAX_LOSS_USD}`);
                this.telegram.sendError(`CIRCUIT BREAKER: loss $${this.stats.totalLoss.toFixed(2)} > max $${CONFIG.MAX_LOSS_USD}`).catch(() => {});
            }
            return;
        }

        // Rate limiting
        const oneHourAgo = Date.now() - 3600000;
        this.tradeTimestamps = this.tradeTimestamps.filter(t => t > oneHourAgo);
        if (this.tradeTimestamps.length >= CONFIG.MAX_TRADES_PER_HOUR) {
            console.log(`[ARB] Rate limited: ${this.tradeTimestamps.length} trades in last hour`);
            return;
        }

        // Slippage check
        if (opp.priceImpact > CONFIG.MAX_SLIPPAGE_PCT) {
            console.log(`[ARB] Slippage too high: ${opp.priceImpact.toFixed(3)}%`);
            return;
        }

        this.isExecuting = true;
        const execStart = Date.now();

        console.log(`\n🔥 [ARB] Executing: ${opp.direction}`);

        try {
            let hlPromise, evmPromise;

            if (opp.direction === 'BUY_EVM_SELL_HL') {
                const amountIn = ethers.parseUnits(opp.tradeSize.toString(), this.evm.usdcDecimals);
                const minOut = ethers.parseUnits(
                    (opp.tokenAmount * (1 - CONFIG.MAX_SLIPPAGE_PCT / 100)).toFixed(8),
                    18
                );

                evmPromise = this.evm.executeSwap(amountIn, minOut, this.evm.pathBuyHype);
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
                evmPromise = this.evm.executeSwap(amountIn, minOut, this.evm.pathSellHype);
            }

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

            console.log(`✅ [ARB] Executed in ${execMs}ms`);
            this.telegram.sendTradeExecution(opp, { evmResult, hlResult, execMs }).catch(() => {});

        } catch (e) {
            this.stats.errors++;
            const execMs = Date.now() - execStart;
            console.error(`❌ [ARB] Execution failed (${execMs}ms):`, e.message);
            this.telegram.sendError(`Trade failed (${execMs}ms): ${e.message}`).catch(() => {});

            // Resync nonce après une erreur
            await this.evm.resyncNonce();
        } finally {
            this.isExecuting = false;
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
                ? this.stats.totalProfit / this.stats.trades
                : 0,
            successRate: this.stats.scans > 0
                ? ((this.stats.opportunities / this.stats.scans) * 100).toFixed(2) + '%'
                : '0%',
            circuitBroken: this.circuitBroken,
            tradesLastHour: this.tradeTimestamps.filter(t => t > Date.now() - 3600000).length,
        };
    }

    getRecentOpportunities(count = 5) {
        return this.lastOpportunities.slice(0, count);
    }

    resetCircuitBreaker() {
        this.circuitBroken = false;
        this.stats.totalLoss = 0;
        console.log('[ARB] Circuit breaker reset');
    }

    _sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    _formatDuration(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        return `${h}h ${m}m ${s}s`;
    }
}

module.exports = ArbitrageEngine;
