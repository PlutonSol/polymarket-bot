const { ethers } = require('ethers');
const CONFIG = require('./config');
const HyperliquidClient = require('./hyperliquid');
const HyperEvmClient = require('./hyperEvm');

/**
 * Moteur d'arbitrage entre Hyperliquid L1 (spot natif) et HyperEVM (DEX AMM)
 *
 * Optimisations de vitesse:
 * - Prix HL + EVM récupérés en parallèle
 * - Exécution buy + sell en parallèle (pas séquentielle)
 * - Telegram non-bloquant (fire-and-forget)
 * - Pré-approval des tokens au démarrage
 * - Cache des decimals, paires, gas price
 * - Pas de re-fetch du gas pendant l'exécution
 */
class ArbitrageEngine {
    constructor(telegram) {
        this.hl = new HyperliquidClient();
        this.evm = new HyperEvmClient();
        this.telegram = telegram;
        this.isRunning = false;
        this.isExecuting = false; // Verrou pour éviter les exécutions concurrentes
        this.stats = {
            scans: 0,
            opportunities: 0,
            trades: 0,
            totalProfit: 0,
            errors: 0,
            startTime: null,
            avgScanMs: 0,
            avgExecMs: 0,
            lastScanMs: 0,
            lastExecMs: 0,
        };
        this.lastOpportunities = [];
    }

    /**
     * Initialisation: pré-chauffe les caches et pré-approuve les tokens
     */
    async warmup() {
        console.log('[ARB] Warming up...');
        await Promise.all([
            this.evm.warmupCaches(),
            this.evm.preApproveTokens(),
            this.hl.getSpotMeta(), // Cache le spotMeta
        ]);
        console.log('[ARB] Warmup complete');
    }

    /**
     * Démarre le scan d'arbitrage
     */
    async start() {
        this.isRunning = true;
        this.stats.startTime = Date.now();

        console.log(`\n[ARB] Engine started - scanning every ${CONFIG.SCAN_INTERVAL_MS}ms`);
        console.log(`[ARB] Min spread: ${CONFIG.MIN_SPREAD_PCT}%`);
        console.log(`[ARB] Trade size: $${CONFIG.TRADE_SIZE_USDC}`);
        console.log(`[ARB] Dry run: ${CONFIG.DRY_RUN}`);
        console.log(`[ARB] Tokens: ${CONFIG.TOKENS.map(t => t.symbol).join(', ')}\n`);

        // Warmup avant de démarrer le scan
        await this.warmup();

        while (this.isRunning) {
            try {
                await this.scan();
            } catch (e) {
                this.stats.errors++;
                console.error('[ARB] Scan error:', e.message);
                if (this.stats.errors > 10 && this.stats.scans < 20) {
                    console.error('[ARB] Too many errors early on, check config');
                }
            }
            await this._sleep(CONFIG.SCAN_INTERVAL_MS);
        }
    }

    stop() {
        this.isRunning = false;
        console.log('[ARB] Engine stopped');
    }

    /**
     * Scan toutes les paires configurées.
     * Optimisé: tous les tokens sont scannés en parallèle.
     */
    async scan() {
        this.stats.scans++;
        const scanStart = Date.now();

        // Scanner tous les tokens en parallèle
        const results = await Promise.allSettled(
            CONFIG.TOKENS.map(token => this.checkArbitrage(token))
        );

        for (const result of results) {
            if (result.status === 'fulfilled' && result.value) {
                const opportunity = result.value;
                this.stats.opportunities++;
                this.lastOpportunities.unshift(opportunity);
                if (this.lastOpportunities.length > 50) {
                    this.lastOpportunities.pop();
                }
                await this.handleOpportunity(opportunity);
            }
        }

        const scanMs = Date.now() - scanStart;
        this.stats.lastScanMs = scanMs;
        this.stats.avgScanMs = this.stats.avgScanMs
            ? (this.stats.avgScanMs * 0.9 + scanMs * 0.1)
            : scanMs;

        // Log périodique
        if (this.stats.scans % 100 === 0) {
            console.log(`[ARB] Scans: ${this.stats.scans} | Opps: ${this.stats.opportunities} | Trades: ${this.stats.trades} | Avg scan: ${this.stats.avgScanMs.toFixed(0)}ms`);
        }
    }

    /**
     * Vérifie s'il y a une opportunité d'arbitrage pour un token.
     * Optimisé: prix HL et EVM récupérés en parallèle.
     */
    async checkArbitrage(token) {
        // Récupérer les prix HL + EVM en parallèle
        const [hlData, evmData, gasData] = await Promise.all([
            this.hl.getSpotBestBidAsk(token.hyperliquidName),
            this.evm.getTokenPriceFromPair(token.evmAddress),
            this.evm.getGasPrice(), // Depuis le cache (refresh 10s)
        ]);

        if (!hlData || !hlData.bestBid || !hlData.bestAsk) {
            if (CONFIG.LOG_LEVEL === 'debug') {
                console.log(`[ARB] No HL data for ${token.symbol}`);
            }
            return null;
        }
        if (!evmData) {
            if (CONFIG.LOG_LEVEL === 'debug') {
                console.log(`[ARB] No EVM data for ${token.symbol}`);
            }
            return null;
        }

        const hlMid = (hlData.bestBid + hlData.bestAsk) / 2;
        const evmPrice = evmData.price;

        const spread = ((evmPrice - hlMid) / hlMid) * 100;
        const absSpread = Math.abs(spread);

        if (CONFIG.LOG_LEVEL === 'debug') {
            console.log(`[ARB] ${token.symbol}: HL=${hlMid.toFixed(4)} EVM=${evmPrice.toFixed(4)} Spread=${spread.toFixed(3)}%`);
        }

        if (absSpread < CONFIG.MIN_SPREAD_PCT) {
            return null;
        }

        // Calculer le prix effectif avec slippage
        const effectiveData = await this.evm.getEffectivePrice(
            token.evmAddress,
            CONFIG.TRADE_SIZE_USDC,
            spread > 0 ? 'sell' : 'buy'
        );

        // Estimer les frais de gas
        const estimatedGasCost = gasData.gasPriceGwei * 250000 / 1e9;

        let direction, buyPrice, sellPrice, buyVenue, sellVenue;

        if (spread > 0) {
            direction = 'BUY_HL_SELL_EVM';
            buyPrice = hlData.bestAsk;
            sellPrice = effectiveData ? effectiveData.effectivePrice : evmPrice;
            buyVenue = 'Hyperliquid';
            sellVenue = 'HyperEVM DEX';
        } else {
            direction = 'BUY_EVM_SELL_HL';
            buyPrice = effectiveData ? effectiveData.effectivePrice : evmPrice;
            sellPrice = hlData.bestBid;
            buyVenue = 'HyperEVM DEX';
            sellVenue = 'Hyperliquid';
        }

        const tokenAmount = CONFIG.TRADE_SIZE_USDC / buyPrice;
        const grossProfit = (sellPrice - buyPrice) * tokenAmount;
        const netProfit = grossProfit - estimatedGasCost;
        const netSpreadPct = (netProfit / CONFIG.TRADE_SIZE_USDC) * 100;

        const hasLiquidity = this._checkLiquidity(
            direction === 'BUY_HL_SELL_EVM' ? hlData.askSize : evmData.tokenReserve,
            tokenAmount
        );

        return {
            timestamp: new Date().toISOString(),
            token: token.symbol,
            direction,
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

    /**
     * Gère une opportunité d'arbitrage détectée.
     * Optimisé: Telegram est fire-and-forget (non-bloquant).
     */
    async handleOpportunity(opp) {
        const profitEmoji = opp.profitable ? '💰' : '👀';
        const dirEmoji = opp.direction === 'BUY_HL_SELL_EVM' ? '➡️' : '⬅️';

        console.log(`\n${profitEmoji} [ARB] Opportunity: ${opp.token}`);
        console.log(`  ${dirEmoji} ${opp.direction}`);
        console.log(`  Buy @ ${opp.buyPrice.toFixed(4)} (${opp.buyVenue})`);
        console.log(`  Sell @ ${opp.sellPrice.toFixed(4)} (${opp.sellVenue})`);
        console.log(`  Spread: ${opp.spread.toFixed(3)}% | Net: ${opp.netSpread.toFixed(3)}%`);
        console.log(`  Profit: $${opp.grossProfit.toFixed(4)} - $${opp.gasCost.toFixed(4)} gas = $${opp.netProfit.toFixed(4)}`);

        // Telegram en fire-and-forget (ne bloque PAS l'exécution)
        this.telegram.sendOpportunity(opp).catch(() => {});

        if (opp.profitable && !CONFIG.DRY_RUN) {
            await this.executeArbitrage(opp);
        } else if (opp.profitable && CONFIG.DRY_RUN) {
            console.log(`  [DRY-RUN] Would execute trade for $${opp.netProfit.toFixed(4)} profit`);
        }
    }

    /**
     * Exécute l'arbitrage.
     * Optimisé:
     * - Buy + Sell en PARALLÈLE (pas séquentiel)
     * - Pas de re-check du gas (déjà vérifié pendant le scan)
     * - Pas d'allowance check (pré-approuvé au démarrage)
     * - Verrou anti-exécution concurrente
     */
    async executeArbitrage(opp) {
        // Verrou: une seule exécution à la fois
        if (this.isExecuting) {
            console.log('[ARB] Already executing, skipping');
            return;
        }
        this.isExecuting = true;
        const execStart = Date.now();

        console.log(`\n🔥 [ARB] Executing arbitrage: ${opp.direction}`);

        try {
            // Vérifier le slippage
            if (opp.priceImpact > CONFIG.MAX_SLIPPAGE_PCT) {
                console.log(`[ARB] Slippage too high: ${opp.priceImpact}% > ${CONFIG.MAX_SLIPPAGE_PCT}% max`);
                return;
            }

            const tokenConfig = CONFIG.TOKENS.find(t => t.symbol === opp.token);
            let hlPromise, evmPromise;

            if (opp.direction === 'BUY_EVM_SELL_HL') {
                const usdcDecimals = 6;
                const amountIn = ethers.parseUnits(opp.tradeSize.toString(), usdcDecimals);
                const minOut = ethers.parseUnits(
                    (opp.tokenAmount * (1 - CONFIG.MAX_SLIPPAGE_PCT / 100)).toFixed(8),
                    tokenConfig.decimals
                );

                // PARALLÈLE: acheter EVM + vendre HL en même temps
                evmPromise = this.evm.executeSwap(
                    opp.token,
                    amountIn,
                    minOut,
                    [CONFIG.USDC_ADDRESS, tokenConfig.evmAddress]
                );

                hlPromise = this.hl.placeSpotOrder({
                    symbol: opp.token,
                    isBuy: false,
                    size: opp.tokenAmount,
                    price: opp.hlBid,
                });
            } else {
                // BUY_HL_SELL_EVM
                const amountIn = ethers.parseUnits(
                    opp.tokenAmount.toFixed(8),
                    tokenConfig.decimals
                );
                const minOut = ethers.parseUnits(
                    (opp.tradeSize * (1 - CONFIG.MAX_SLIPPAGE_PCT / 100)).toFixed(6),
                    6
                );

                // PARALLÈLE: acheter HL + vendre EVM en même temps
                hlPromise = this.hl.placeSpotOrder({
                    symbol: opp.token,
                    isBuy: true,
                    size: opp.tokenAmount,
                    price: opp.hlAsk,
                });

                evmPromise = this.evm.executeSwap(
                    opp.token,
                    amountIn,
                    minOut,
                    [tokenConfig.evmAddress, CONFIG.USDC_ADDRESS]
                );
            }

            // Attendre les deux résultats en parallèle
            const [evmResult, hlResult] = await Promise.all([evmPromise, hlPromise]);

            const execMs = Date.now() - execStart;
            this.stats.trades++;
            this.stats.totalProfit += opp.netProfit;
            this.stats.lastExecMs = execMs;
            this.stats.avgExecMs = this.stats.avgExecMs
                ? (this.stats.avgExecMs * 0.9 + execMs * 0.1)
                : execMs;

            console.log(`✅ [ARB] Trade executed in ${execMs}ms!`);
            console.log(`  EVM: ${JSON.stringify(evmResult)}`);
            console.log(`  HL: ${JSON.stringify(hlResult)}`);

            // Telegram en fire-and-forget
            this.telegram.sendTradeExecution(opp, { evmResult, hlResult, execMs }).catch(() => {});

        } catch (e) {
            this.stats.errors++;
            const execMs = Date.now() - execStart;
            console.error(`❌ [ARB] Trade execution error (${execMs}ms):`, e.message);
            this.telegram.sendError(`Trade failed (${execMs}ms): ${e.message}`).catch(() => {});
        } finally {
            this.isExecuting = false;
        }
    }

    _checkLiquidity(availableSize, neededSize) {
        return availableSize >= neededSize * 1.1;
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
        };
    }

    getRecentOpportunities(count = 5) {
        return this.lastOpportunities.slice(0, count);
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
