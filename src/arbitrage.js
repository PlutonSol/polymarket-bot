const { ethers } = require('ethers');
const CONFIG = require('./config');
const HyperliquidClient = require('./hyperliquid');
const HyperEvmClient = require('./hyperEvm');

/**
 * Moteur d'arbitrage entre Hyperliquid L1 (spot natif) et HyperEVM (DEX AMM)
 *
 * Stratégie:
 * 1. Récupérer le prix spot sur Hyperliquid natif (orderbook)
 * 2. Récupérer le prix sur le DEX EVM (AMM reserves)
 * 3. Si spread > seuil → exécuter l'arbitrage:
 *    - Si prix EVM < prix HL: acheter sur EVM, vendre sur HL
 *    - Si prix HL < prix EVM: acheter sur HL, vendre sur EVM
 */
class ArbitrageEngine {
    constructor(telegram) {
        this.hl = new HyperliquidClient();
        this.evm = new HyperEvmClient();
        this.telegram = telegram;
        this.isRunning = false;
        this.stats = {
            scans: 0,
            opportunities: 0,
            trades: 0,
            totalProfit: 0,
            errors: 0,
            startTime: null,
        };
        this.lastOpportunities = [];
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

    /**
     * Arrête le moteur
     */
    stop() {
        this.isRunning = false;
        console.log('[ARB] Engine stopped');
    }

    /**
     * Scan toutes les paires configurées
     */
    async scan() {
        this.stats.scans++;
        const timestamp = new Date().toISOString();

        for (const token of CONFIG.TOKENS) {
            try {
                const opportunity = await this.checkArbitrage(token);
                if (opportunity) {
                    this.stats.opportunities++;
                    this.lastOpportunities.unshift(opportunity);
                    if (this.lastOpportunities.length > 50) {
                        this.lastOpportunities.pop();
                    }

                    await this.handleOpportunity(opportunity);
                }
            } catch (e) {
                if (CONFIG.LOG_LEVEL === 'debug') {
                    console.error(`[ARB] Error checking ${token.symbol}:`, e.message);
                }
            }
        }

        // Log périodique
        if (this.stats.scans % 100 === 0) {
            console.log(`[ARB] ${timestamp} - Scans: ${this.stats.scans}, Opps: ${this.stats.opportunities}, Trades: ${this.stats.trades}`);
        }
    }

    /**
     * Vérifie s'il y a une opportunité d'arbitrage pour un token
     */
    async checkArbitrage(token) {
        // 1. Prix sur Hyperliquid natif (spot orderbook)
        const hlData = await this.hl.getSpotBestBidAsk(token.hyperliquidName);
        if (!hlData || !hlData.bestBid || !hlData.bestAsk) {
            if (CONFIG.LOG_LEVEL === 'debug') {
                console.log(`[ARB] No HL data for ${token.symbol}`);
            }
            return null;
        }

        // 2. Prix sur DEX EVM (AMM)
        const evmData = await this.evm.getTokenPriceFromPair(token.evmAddress);
        if (!evmData) {
            if (CONFIG.LOG_LEVEL === 'debug') {
                console.log(`[ARB] No EVM data for ${token.symbol}`);
            }
            return null;
        }

        const hlMid = (hlData.bestBid + hlData.bestAsk) / 2;
        const evmPrice = evmData.price;

        // 3. Calculer le spread
        const spread = ((evmPrice - hlMid) / hlMid) * 100;
        const absSpread = Math.abs(spread);

        if (CONFIG.LOG_LEVEL === 'debug') {
            console.log(`[ARB] ${token.symbol}: HL=${hlMid.toFixed(4)} EVM=${evmPrice.toFixed(4)} Spread=${spread.toFixed(3)}%`);
        }

        // 4. Vérifier si le spread est suffisant
        if (absSpread < CONFIG.MIN_SPREAD_PCT) {
            return null;
        }

        // 5. Calculer le prix effectif avec slippage pour le montant de trade
        const effectiveData = await this.evm.getEffectivePrice(
            token.evmAddress,
            CONFIG.TRADE_SIZE_USDC,
            spread > 0 ? 'sell' : 'buy'
        );

        // 6. Estimer les frais de gas
        const gasData = await this.evm.getGasPrice();
        const estimatedGasCost = gasData.gasPriceGwei * 250000 / 1e9; // ~250k gas pour un swap

        // 7. Calculer le profit net
        let direction, buyPrice, sellPrice, buyVenue, sellVenue;

        if (spread > 0) {
            // EVM plus cher que HL → acheter sur HL, vendre sur EVM
            direction = 'BUY_HL_SELL_EVM';
            buyPrice = hlData.bestAsk;
            sellPrice = effectiveData ? effectiveData.effectivePrice : evmPrice;
            buyVenue = 'Hyperliquid';
            sellVenue = 'HyperEVM DEX';
        } else {
            // HL plus cher que EVM → acheter sur EVM, vendre sur HL
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

        // Vérifier la liquidité suffisante
        const hasLiquidity = this._checkLiquidity(
            direction === 'BUY_HL_SELL_EVM' ? hlData.askSize : evmData.tokenReserve,
            tokenAmount
        );

        const opportunity = {
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

        return opportunity;
    }

    /**
     * Gère une opportunité d'arbitrage détectée
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
        console.log(`  Liquidity: $${opp.evmLiquidity.toFixed(0)} | Impact: ${opp.priceImpact.toFixed(3)}%`);

        // Notifier via Telegram
        await this.telegram.sendOpportunity(opp);

        // Exécuter si profitable et pas en dry-run
        if (opp.profitable && !CONFIG.DRY_RUN) {
            await this.executeArbitrage(opp);
        } else if (opp.profitable && CONFIG.DRY_RUN) {
            console.log(`  [DRY-RUN] Would execute trade for $${opp.netProfit.toFixed(4)} profit`);
        }
    }

    /**
     * Exécute l'arbitrage
     */
    async executeArbitrage(opp) {
        console.log(`\n🔥 [ARB] Executing arbitrage: ${opp.direction}`);

        try {
            // Vérifier le gas price
            const gasData = await this.evm.getGasPrice();
            if (gasData.gasPriceGwei > CONFIG.MAX_GAS_PRICE_GWEI) {
                console.log(`[ARB] Gas too high: ${gasData.gasPriceGwei} gwei > ${CONFIG.MAX_GAS_PRICE_GWEI} max`);
                return;
            }

            // Vérifier le slippage
            if (opp.priceImpact > CONFIG.MAX_SLIPPAGE_PCT) {
                console.log(`[ARB] Slippage too high: ${opp.priceImpact}% > ${CONFIG.MAX_SLIPPAGE_PCT}% max`);
                return;
            }

            let evmResult, hlResult;

            if (opp.direction === 'BUY_EVM_SELL_HL') {
                // Étape 1: Acheter sur EVM
                const usdcDecimals = 6; // USDC standard
                const amountIn = ethers.parseUnits(opp.tradeSize.toString(), usdcDecimals);
                const minOut = ethers.parseUnits(
                    (opp.tokenAmount * (1 - CONFIG.MAX_SLIPPAGE_PCT / 100)).toFixed(8),
                    18
                );

                evmResult = await this.evm.executeSwap(
                    opp.token,
                    amountIn,
                    minOut,
                    [CONFIG.USDC_ADDRESS, CONFIG.TOKENS.find(t => t.symbol === opp.token).evmAddress]
                );

                // Étape 2: Vendre sur Hyperliquid
                hlResult = await this.hl.placeSpotOrder({
                    symbol: opp.token,
                    isBuy: false,
                    size: opp.tokenAmount,
                    price: opp.hlBid,
                });
            } else {
                // BUY_HL_SELL_EVM
                // Étape 1: Acheter sur Hyperliquid
                hlResult = await this.hl.placeSpotOrder({
                    symbol: opp.token,
                    isBuy: true,
                    size: opp.tokenAmount,
                    price: opp.hlAsk,
                });

                // Étape 2: Vendre sur EVM
                const tokenConfig = CONFIG.TOKENS.find(t => t.symbol === opp.token);
                const amountIn = ethers.parseUnits(
                    opp.tokenAmount.toFixed(8),
                    tokenConfig.decimals
                );
                const minOut = ethers.parseUnits(
                    (opp.tradeSize * (1 - CONFIG.MAX_SLIPPAGE_PCT / 100)).toFixed(6),
                    6
                );

                evmResult = await this.evm.executeSwap(
                    opp.token,
                    amountIn,
                    minOut,
                    [tokenConfig.evmAddress, CONFIG.USDC_ADDRESS]
                );
            }

            this.stats.trades++;
            this.stats.totalProfit += opp.netProfit;

            console.log(`✅ [ARB] Trade executed! EVM: ${JSON.stringify(evmResult)}`);
            await this.telegram.sendTradeExecution(opp, { evmResult, hlResult });

        } catch (e) {
            this.stats.errors++;
            console.error(`❌ [ARB] Trade execution error:`, e.message);
            await this.telegram.sendError(`Trade execution failed: ${e.message}`);
        }
    }

    /**
     * Vérifie que la liquidité est suffisante
     */
    _checkLiquidity(availableSize, neededSize) {
        return availableSize >= neededSize * 1.1; // 10% de marge
    }

    /**
     * Retourne les statistiques
     */
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

    /**
     * Retourne les dernières opportunités
     */
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
