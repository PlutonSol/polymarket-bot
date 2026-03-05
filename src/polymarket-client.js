const { CONFIG } = require('./config');
const log = require('./logger');

let marketsCache = [];
let marketsCacheTime = 0;
const CACHE_TTL = 2 * 60 * 1000; // 2 min (plus court pour le scalping)

/**
 * Client Polymarket - Optimisé pour le scalping sur marchés à gros volume
 */
class PolymarketClient {
    constructor() {
        this.clobClient = null;
        this.apiCreds = null;
        this.initialized = false;
    }

    async initialize() {
        if (CONFIG.DRY_RUN) {
            log.info('Mode DRY RUN - pas de connexion CLOB');
            this.initialized = true;
            return;
        }

        try {
            const { ClobClient } = require('@polymarket/clob-client');

            if (CONFIG.POLY_API_KEY && CONFIG.POLY_API_SECRET && CONFIG.POLY_API_PASSPHRASE) {
                this.apiCreds = {
                    key: CONFIG.POLY_API_KEY,
                    secret: CONFIG.POLY_API_SECRET,
                    passphrase: CONFIG.POLY_API_PASSPHRASE,
                };
                this.clobClient = new ClobClient(
                    CONFIG.CLOB_HOST,
                    CONFIG.CHAIN_ID,
                    undefined,
                    this.apiCreds,
                    undefined,
                    CONFIG.WALLET_ADDRESS
                );
            } else {
                const { ethers } = require('ethers');
                const wallet = new ethers.Wallet(CONFIG.PRIVATE_KEY);
                this.clobClient = new ClobClient(CONFIG.CLOB_HOST, CONFIG.CHAIN_ID, wallet);
                this.apiCreds = await this.clobClient.createOrDeriveApiKey();
                log.info('API keys dérivées');
                this.clobClient = new ClobClient(CONFIG.CLOB_HOST, CONFIG.CHAIN_ID, wallet, this.apiCreds);
            }

            this.initialized = true;
            log.info('Client CLOB initialisé');
        } catch (error) {
            log.error('Erreur init CLOB:', error.message);
            throw error;
        }
    }

    // ========== MARCHÉS - Filtrage volume >= 1M ==========

    /**
     * Récupère les marchés actifs avec volume >= MIN_MARKET_VOLUME (1M par défaut)
     */
    async getHighVolumeMarkets(limit = 100) {
        try {
            const params = new URLSearchParams({
                limit: limit.toString(),
                active: 'true',
                closed: 'false',
                order: 'volume24hr',
                ascending: 'false',
            });

            const res = await fetch(`${CONFIG.GAMMA_HOST}/markets?${params}`);
            if (!res.ok) throw new Error(`Gamma API ${res.status}`);
            const markets = await res.json();

            // Filtrer : actif + tokens tradables + volume >= 1M
            return markets.filter(m => {
                if (!m.clobTokenIds || m.clobTokenIds.length === 0 || !m.active) return false;
                const vol = parseFloat(m.volume || m.volumeNum || 0);
                return vol >= CONFIG.MIN_MARKET_VOLUME;
            });
        } catch (error) {
            log.error('Erreur fetch marchés:', error.message);
            return [];
        }
    }

    /**
     * Récupère les marchés à gros volume avec cache
     */
    async getCachedHighVolumeMarkets() {
        const now = Date.now();
        if (marketsCache.length > 0 && now - marketsCacheTime < CACHE_TTL) {
            return marketsCache;
        }
        marketsCache = await this.getHighVolumeMarkets();
        marketsCacheTime = now;
        log.info(`Cache marchés: ${marketsCache.length} marchés >= $${(CONFIG.MIN_MARKET_VOLUME / 1e6).toFixed(0)}M volume`);
        return marketsCache;
    }

    /**
     * Invalide le cache manuellement
     */
    invalidateCache() {
        marketsCache = [];
        marketsCacheTime = 0;
    }

    // ========== ORDERBOOK - Analyse pour scalping ==========

    /**
     * Récupère l'orderbook complet pour un token
     */
    async getOrderBook(tokenId) {
        try {
            const res = await fetch(`${CONFIG.CLOB_HOST}/book?token_id=${tokenId}`);
            if (!res.ok) throw new Error(`Orderbook API ${res.status}`);
            return await res.json();
        } catch (error) {
            log.error('Erreur orderbook:', error.message);
            return null;
        }
    }

    /**
     * Analyse l'orderbook pour le scalping.
     * Retourne les infos nécessaires : bestBid, bestAsk, spread, profondeur, etc.
     */
    async analyzeBookForScalp(tokenId) {
        const book = await this.getOrderBook(tokenId);
        if (!book) return null;

        const bids = (book.bids || []).map(o => ({ price: parseFloat(o.price), size: parseFloat(o.size) }));
        const asks = (book.asks || []).map(o => ({ price: parseFloat(o.price), size: parseFloat(o.size) }));

        if (bids.length === 0 || asks.length === 0) return null;

        // Trier : bids décroissant, asks croissant
        bids.sort((a, b) => b.price - a.price);
        asks.sort((a, b) => a.price - b.price);

        const bestBid = bids[0].price;
        const bestAsk = asks[0].price;
        const spreadCents = Math.round((bestAsk - bestBid) * 100);

        // Profondeur en USD sur les 5 premiers niveaux
        const bidDepthUsd = bids.slice(0, 5).reduce((s, o) => s + o.price * o.size, 0);
        const askDepthUsd = asks.slice(0, 5).reduce((s, o) => s + o.price * o.size, 0);

        // Volume disponible au best bid et best ask
        const bestBidSize = bids[0].size;
        const bestAskSize = asks[0].size;

        // Vérifier s'il y a de la place pour placer un buy au bestBid et sell au bestBid + tick
        const sellPrice = +(bestBid + CONFIG.SCALP_TICK).toFixed(2);
        const canSellAtTick = sellPrice <= bestAsk; // Notre sell serait dans le spread ou au ask

        // Volume disponible au prix de sell (asks à ce niveau)
        const askVolumeAtSellPrice = asks
            .filter(o => o.price <= sellPrice)
            .reduce((s, o) => s + o.size, 0);

        return {
            bestBid,
            bestAsk,
            bestBidSize,
            bestAskSize,
            spreadCents,
            bidDepthUsd,
            askDepthUsd,
            sellPrice,
            canSellAtTick,
            askVolumeAtSellPrice,
            bidsLevels: bids.length,
            asksLevels: asks.length,
        };
    }

    /**
     * Enrichit un marché avec analyse complète pour le scalping
     */
    async enrichForScalping(market) {
        const tokenIds = JSON.parse(market.clobTokenIds || '[]');
        if (tokenIds.length === 0) return null;

        const yesTokenId = tokenIds[0];
        const noTokenId = tokenIds.length > 1 ? tokenIds[1] : null;

        // Analyser les deux tokens si possible
        const [yesBook, noBook] = await Promise.all([
            this.analyzeBookForScalp(yesTokenId),
            noTokenId ? this.analyzeBookForScalp(noTokenId) : null,
        ]);

        const totalVolume = parseFloat(market.volume || market.volumeNum || 0);
        const volume24h = parseFloat(market.volume24hr || 0);

        return {
            conditionId: market.conditionId || market.condition_id,
            question: market.question,
            slug: market.slug,
            totalVolume,
            volume24h,
            yesTokenId,
            noTokenId,
            yesBook,
            noBook,
        };
    }

    // ========== TRADING ==========

    /**
     * Place un ordre (GTC par défaut pour le scalping)
     */
    async placeOrder({ tokenId, side, price, size, orderType = 'GTC' }) {
        if (CONFIG.DRY_RUN) {
            const simulated = {
                id: `DRY-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                status: 'SIMULATED',
                side,
                price,
                size,
                tokenId,
                timestamp: new Date().toISOString(),
            };
            log.trade('DRY RUN:', JSON.stringify(simulated));
            return simulated;
        }

        if (!this.clobClient) throw new Error('Client CLOB non initialisé');

        try {
            const { Side, OrderType: OT } = require('@polymarket/clob-client');

            const orderPayload = {
                tokenID: tokenId,
                price,
                side: side === 'buy' ? Side.BUY : Side.SELL,
                size,
                feeRateBps: 0,
                nonce: 0,
                expiration: 0,
            };

            const signedOrder = await this.clobClient.createOrder(orderPayload);
            const result = await this.clobClient.postOrder(signedOrder, orderType === 'GTC' ? OT.GTC : OT.FOK);

            log.trade('Ordre placé:', { orderId: result.orderID, side, price, size });
            return {
                id: result.orderID,
                status: result.status || 'PLACED',
                side, price, size, tokenId,
                timestamp: new Date().toISOString(),
            };
        } catch (error) {
            log.error('Erreur ordre:', error.message);
            throw error;
        }
    }

    /**
     * Place un ordre FOK (Fill-Or-Kill) - pour le sell immédiat du scalp
     */
    async placeFOKOrder({ tokenId, side, price, size }) {
        return this.placeOrder({ tokenId, side, price, size, orderType: 'FOK' });
    }

    async cancelOrder(orderId) {
        if (CONFIG.DRY_RUN) {
            log.trade('DRY RUN cancel:', orderId);
            return { success: true };
        }
        try {
            const result = await this.clobClient.cancelOrder({ orderID: orderId });
            log.trade('Annulé:', orderId);
            return result;
        } catch (error) {
            log.error('Erreur cancel:', error.message);
            throw error;
        }
    }

    async cancelAllOrders() {
        if (CONFIG.DRY_RUN) {
            log.trade('DRY RUN cancel all');
            return { success: true };
        }
        try {
            const result = await this.clobClient.cancelAll();
            log.trade('Tous annulés');
            return result;
        } catch (error) {
            log.error('Erreur cancel all:', error.message);
            throw error;
        }
    }

    async getOpenOrders() {
        if (CONFIG.DRY_RUN) return [];
        try {
            return (await this.clobClient.getOpenOrders()) || [];
        } catch (error) {
            log.error('Erreur open orders:', error.message);
            return [];
        }
    }

    // ========== WALLET BALANCE ==========

    /**
     * Récupère le solde USDC du wallet sur Polygon.
     * En DRY_RUN retourne une balance simulée.
     * Cache de 30s pour éviter de spammer le RPC.
     */
    async getWalletBalance() {
        if (CONFIG.DRY_RUN) {
            return this._dryRunBalance;
        }

        // Cache 30s
        const now = Date.now();
        if (this._balanceCache && now - this._balanceCacheTime < 30_000) {
            return this._balanceCache;
        }

        try {
            // USDC sur Polygon
            const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
            const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

            const { ethers } = require('ethers');
            const provider = new ethers.providers.JsonRpcProvider('https://polygon-rpc.com');
            const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
            const raw = await usdc.balanceOf(CONFIG.WALLET_ADDRESS);
            // USDC a 6 decimales
            const balance = parseFloat(ethers.utils.formatUnits(raw, 6));
            this._balanceCache = balance;
            this._balanceCacheTime = now;
            log.info(`Wallet balance: $${balance.toFixed(2)} USDC`);
            return balance;
        } catch (error) {
            log.error('Erreur balance:', error.message);
            return this._balanceCache || 0;
        }
    }

    /**
     * Calcule la taille max d'un trade basée sur 20% du wallet
     */
    async getMaxTradeSize() {
        const balance = await this.getWalletBalance();
        const maxFromWallet = balance * CONFIG.MAX_WALLET_EXPOSURE;
        const maxSize = Math.min(maxFromWallet, CONFIG.MAX_TRADE_SIZE);
        return Math.max(maxSize, 0);
    }
}

PolymarketClient.prototype._dryRunBalance = 1000;
PolymarketClient.prototype._balanceCache = null;
PolymarketClient.prototype._balanceCacheTime = 0;

module.exports = PolymarketClient;
