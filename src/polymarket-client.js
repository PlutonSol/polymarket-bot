const { CONFIG } = require('./config');
const log = require('./logger');

// Cache pour les données de marché
let marketsCache = [];
let marketsCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Client Polymarket - Gère la connexion CLOB et les opérations de trading
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

            // Si des API creds existent, les utiliser directement
            if (CONFIG.POLY_API_KEY && CONFIG.POLY_API_SECRET && CONFIG.POLY_API_PASSPHRASE) {
                this.apiCreds = {
                    key: CONFIG.POLY_API_KEY,
                    secret: CONFIG.POLY_API_SECRET,
                    passphrase: CONFIG.POLY_API_PASSPHRASE,
                };
                this.clobClient = new ClobClient(
                    CONFIG.CLOB_HOST,
                    CONFIG.CHAIN_ID,
                    undefined, // pas de signer direct
                    this.apiCreds,
                    undefined,
                    CONFIG.WALLET_ADDRESS
                );
            } else {
                // Créer le client avec la clé privée et dériver les API creds
                const { ethers } = require('ethers');
                const wallet = new ethers.Wallet(CONFIG.PRIVATE_KEY);

                this.clobClient = new ClobClient(
                    CONFIG.CLOB_HOST,
                    CONFIG.CHAIN_ID,
                    wallet
                );

                // Dériver ou créer les API keys
                this.apiCreds = await this.clobClient.createOrDeriveApiKey();
                log.info('API keys dérivées avec succès');

                // Recréer le client avec les creds
                this.clobClient = new ClobClient(
                    CONFIG.CLOB_HOST,
                    CONFIG.CHAIN_ID,
                    wallet,
                    this.apiCreds
                );
            }

            this.initialized = true;
            log.info('Client Polymarket CLOB initialisé');
        } catch (error) {
            log.error('Erreur initialisation CLOB:', error.message);
            throw error;
        }
    }

    // ========== LECTURE MARCHÉS ==========

    /**
     * Récupère les marchés actifs depuis l'API Gamma
     */
    async getActiveMarkets({ limit = 50, active = true, closed = false } = {}) {
        try {
            const params = new URLSearchParams({
                limit: limit.toString(),
                active: active.toString(),
                closed: closed.toString(),
                order: 'volume24hr',
                ascending: 'false',
            });

            const res = await fetch(`${CONFIG.GAMMA_HOST}/markets?${params}`);
            if (!res.ok) throw new Error(`Gamma API ${res.status}`);
            const markets = await res.json();

            // Filtrer les marchés qui ont des tokens tradables
            return markets.filter(m =>
                m.clobTokenIds && m.clobTokenIds.length > 0 && m.active
            );
        } catch (error) {
            log.error('Erreur fetch marchés:', error.message);
            return [];
        }
    }

    /**
     * Récupère les marchés avec cache
     */
    async getCachedMarkets(limit = 50) {
        const now = Date.now();
        if (marketsCache.length > 0 && now - marketsCacheTime < CACHE_TTL) {
            return marketsCache;
        }
        marketsCache = await this.getActiveMarkets({ limit });
        marketsCacheTime = now;
        return marketsCache;
    }

    /**
     * Récupère le carnet d'ordres pour un token
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
     * Récupère le prix mid-point d'un token
     */
    async getMidpoint(tokenId) {
        try {
            const res = await fetch(`${CONFIG.CLOB_HOST}/midpoint?token_id=${tokenId}`);
            if (!res.ok) return null;
            const data = await res.json();
            return parseFloat(data.mid);
        } catch (error) {
            return null;
        }
    }

    /**
     * Récupère le spread bid/ask
     */
    async getSpread(tokenId) {
        try {
            const res = await fetch(`${CONFIG.CLOB_HOST}/spread?token_id=${tokenId}`);
            if (!res.ok) return null;
            return await res.json();
        } catch (error) {
            return null;
        }
    }

    /**
     * Récupère les prix bid/ask
     */
    async getPrice(tokenId, side = 'buy') {
        try {
            const res = await fetch(`${CONFIG.CLOB_HOST}/price?token_id=${tokenId}&side=${side}`);
            if (!res.ok) return null;
            const data = await res.json();
            return parseFloat(data.price);
        } catch (error) {
            return null;
        }
    }

    /**
     * Enrichit un marché avec les données de prix live
     */
    async enrichMarketData(market) {
        const tokenIds = JSON.parse(market.clobTokenIds || '[]');
        if (tokenIds.length === 0) return null;

        const yesTokenId = tokenIds[0];
        const noTokenId = tokenIds.length > 1 ? tokenIds[1] : null;

        const [yesMid, orderbook] = await Promise.all([
            this.getMidpoint(yesTokenId),
            this.getOrderBook(yesTokenId),
        ]);

        let spread = null;
        let bestBid = null;
        let bestAsk = null;
        let liquidity = 0;

        if (orderbook) {
            const bids = orderbook.bids || [];
            const asks = orderbook.asks || [];
            bestBid = bids.length > 0 ? parseFloat(bids[0].price) : null;
            bestAsk = asks.length > 0 ? parseFloat(asks[0].price) : null;
            if (bestBid && bestAsk) {
                spread = ((bestAsk - bestBid) / bestAsk) * 100;
            }
            // Calculer la liquidité sur les 5 premiers niveaux
            liquidity = bids.slice(0, 5).reduce((s, b) => s + parseFloat(b.size) * parseFloat(b.price), 0)
                      + asks.slice(0, 5).reduce((s, a) => s + parseFloat(a.size) * parseFloat(a.price), 0);
        }

        return {
            ...market,
            yesTokenId,
            noTokenId,
            yesMid,
            noMid: yesMid ? 1 - yesMid : null,
            bestBid,
            bestAsk,
            spread,
            liquidity,
            volume24h: parseFloat(market.volume24hr || market.volume || 0),
        };
    }

    // ========== TRADING ==========

    /**
     * Place un ordre d'achat/vente
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
            log.trade('DRY RUN ordre:', simulated);
            return simulated;
        }

        if (!this.clobClient) throw new Error('Client CLOB non initialisé');

        try {
            const { Side, OrderType: OT } = require('@polymarket/clob-client');

            // Récupérer le tickSize et negRisk depuis le marché
            const marketInfo = await this.getMarketInfoByToken(tokenId);
            const tickSize = marketInfo?.minimum_tick_size || '0.01';
            const negRisk = marketInfo?.neg_risk || false;

            const orderPayload = {
                tokenID: tokenId,
                price: price,
                side: side === 'buy' ? Side.BUY : Side.SELL,
                size: size,
                feeRateBps: 0,
                nonce: 0,
                expiration: 0,
            };

            const signedOrder = await this.clobClient.createOrder(orderPayload);
            const result = await this.clobClient.postOrder(signedOrder, orderType === 'GTC' ? OT.GTC : OT.FOK);

            log.trade('Ordre placé:', {
                orderId: result.orderID,
                side,
                price,
                size,
                total: (price * size).toFixed(2),
            });

            return {
                id: result.orderID,
                status: result.status || 'PLACED',
                side,
                price,
                size,
                tokenId,
                timestamp: new Date().toISOString(),
            };
        } catch (error) {
            log.error('Erreur placement ordre:', error.message);
            throw error;
        }
    }

    /**
     * Annule un ordre
     */
    async cancelOrder(orderId) {
        if (CONFIG.DRY_RUN) {
            log.trade('DRY RUN annulation:', orderId);
            return { success: true };
        }

        try {
            const result = await this.clobClient.cancelOrder({ orderID: orderId });
            log.trade('Ordre annulé:', orderId);
            return result;
        } catch (error) {
            log.error('Erreur annulation:', error.message);
            throw error;
        }
    }

    /**
     * Annule tous les ordres ouverts
     */
    async cancelAllOrders() {
        if (CONFIG.DRY_RUN) {
            log.trade('DRY RUN annulation de tous les ordres');
            return { success: true };
        }

        try {
            const result = await this.clobClient.cancelAll();
            log.trade('Tous les ordres annulés');
            return result;
        } catch (error) {
            log.error('Erreur annulation globale:', error.message);
            throw error;
        }
    }

    /**
     * Récupère les ordres ouverts
     */
    async getOpenOrders() {
        if (CONFIG.DRY_RUN) return [];
        try {
            const result = await this.clobClient.getOpenOrders();
            return result || [];
        } catch (error) {
            log.error('Erreur fetch ordres ouverts:', error.message);
            return [];
        }
    }

    /**
     * Récupère les infos marché depuis un token ID
     */
    async getMarketInfoByToken(tokenId) {
        try {
            const res = await fetch(`${CONFIG.GAMMA_HOST}/markets?clob_token_ids=${tokenId}`);
            if (!res.ok) return null;
            const data = await res.json();
            return Array.isArray(data) && data.length > 0 ? data[0] : null;
        } catch (error) {
            return null;
        }
    }
}

module.exports = PolymarketClient;
