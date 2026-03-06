const { CONFIG } = require('./config');
const log = require('./logger');

let marketsCache = [];
let marketsCacheTime = 0;
const CACHE_TTL = 2 * 60 * 1000; // 2 min

/**
 * Client Polymarket - Optimisé pour le scalping sur marchés à gros volume
 * Gère le système de proxy wallet de Polymarket (SignatureType.POLY_PROXY)
 */
class PolymarketClient {
    constructor() {
        this.clobClient = null;
        this.apiCreds = null;
        this.initialized = false;
        this.proxyWalletAddress = null; // Adresse du proxy wallet Polymarket
    }

    async initialize() {
        if (CONFIG.DRY_RUN) {
            log.info('Mode DRY RUN - pas de connexion CLOB');
            this.initialized = true;
            return;
        }

        try {
            const { ClobClient } = require('@polymarket/clob-client');
            const { SignatureType } = require('@polymarket/order-utils');
            const { ethers } = require('ethers');

            const wallet = new ethers.Wallet(CONFIG.PRIVATE_KEY);
            const signerAddress = await wallet.getAddress();
            log.info(`Signer (EOA): ${signerAddress}`);

            // Étape 1: Obtenir ou dériver les API credentials
            if (CONFIG.POLY_API_KEY && CONFIG.POLY_API_SECRET && CONFIG.POLY_API_PASSPHRASE) {
                this.apiCreds = {
                    key: CONFIG.POLY_API_KEY,
                    secret: CONFIG.POLY_API_SECRET,
                    passphrase: CONFIG.POLY_API_PASSPHRASE,
                };
                log.info('API creds fournies via .env');
            } else {
                // Dériver les API keys depuis la private key
                const tempClient = new ClobClient(CONFIG.CLOB_HOST, CONFIG.CHAIN_ID, wallet);
                this.apiCreds = await tempClient.createOrDeriveApiKey();
                log.info('API keys dérivées depuis la private key');
            }

            // Étape 2: Déterminer l'adresse du proxy wallet
            // Polymarket utilise un proxy wallet par utilisateur - les fonds sont là-dedans
            if (CONFIG.PROXY_WALLET_ADDRESS) {
                this.proxyWalletAddress = CONFIG.PROXY_WALLET_ADDRESS;
                log.info(`Proxy wallet (config): ${this.proxyWalletAddress}`);
            } else {
                // Tenter de récupérer le proxy wallet via l'API
                // On crée un client temporaire pour appeler getBalanceAllowance
                // qui nécessite que le proxy wallet soit configuré
                // Fallback: utiliser WALLET_ADDRESS s'il est fourni
                if (CONFIG.WALLET_ADDRESS && CONFIG.WALLET_ADDRESS !== signerAddress) {
                    // L'utilisateur a fourni une adresse différente de l'EOA -> c'est probablement le proxy
                    this.proxyWalletAddress = CONFIG.WALLET_ADDRESS;
                    log.info(`Proxy wallet (WALLET_ADDRESS): ${this.proxyWalletAddress}`);
                } else {
                    // Essayer de dériver le proxy wallet via l'API
                    try {
                        const tempClient = new ClobClient(
                            CONFIG.CLOB_HOST,
                            CONFIG.CHAIN_ID,
                            wallet,
                            this.apiCreds,
                            SignatureType.POLY_PROXY,
                            signerAddress, // temporaire
                        );
                        // getApiKeys peut retourner les infos du proxy wallet
                        const apiKeys = await tempClient.getApiKeys();
                        if (apiKeys && apiKeys.length > 0 && apiKeys[0].proxyAddress) {
                            this.proxyWalletAddress = apiKeys[0].proxyAddress;
                            log.info(`Proxy wallet (API): ${this.proxyWalletAddress}`);
                        }
                    } catch (e) {
                        log.warn('Impossible de dériver le proxy wallet via API:', e.message);
                    }

                    if (!this.proxyWalletAddress) {
                        throw new Error(
                            'PROXY_WALLET_ADDRESS requis. Trouvez-le sur polymarket.com > Settings > votre adresse proxy, ' +
                            'ou dans la console navigateur. Ajoutez PROXY_WALLET_ADDRESS=0x... dans .env'
                        );
                    }
                }
            }

            // Étape 3: Créer le client CLOB final avec le proxy wallet et SignatureType.POLY_PROXY
            this.clobClient = new ClobClient(
                CONFIG.CLOB_HOST,
                CONFIG.CHAIN_ID,
                wallet,
                this.apiCreds,
                SignatureType.POLY_PROXY, // IMPORTANT: signer via le proxy wallet
                this.proxyWalletAddress,  // Adresse du proxy wallet (funder)
            );

            this.initialized = true;
            log.info('Client CLOB initialisé (POLY_PROXY mode)');

            // Étape 4: Vérifier l'allowance USDC
            await this._checkAndSetAllowance();

        } catch (error) {
            log.error('Erreur init CLOB:', error.message);
            throw error;
        }
    }

    // ========== ALLOWANCE USDC ==========

    /**
     * Vérifie et active l'allowance USDC pour le trading.
     * Polymarket nécessite que le proxy wallet autorise le CTF Exchange à dépenser les USDC.
     * L'API CLOB gère ça via getBalanceAllowance / updateBalanceAllowance.
     */
    async _checkAndSetAllowance() {
        try {
            const { AssetType } = require('@polymarket/clob-client');

            // Vérifier l'allowance actuelle pour le collateral (USDC)
            const allowance = await this.clobClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
            log.info(`Allowance USDC: ${JSON.stringify(allowance)}`);

            // Si pas d'allowance suffisante, l'activer
            if (!allowance || parseFloat(allowance.balance_allowance || '0') === 0) {
                log.info('Activation de l\'allowance USDC...');
                await this.clobClient.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
                log.info('Allowance USDC activée');
            }

            // Vérifier aussi l'allowance pour les conditional tokens
            const condAllowance = await this.clobClient.getBalanceAllowance({ asset_type: AssetType.CONDITIONAL });
            log.info(`Allowance Conditional: ${JSON.stringify(condAllowance)}`);

            if (!condAllowance || parseFloat(condAllowance.balance_allowance || '0') === 0) {
                log.info('Activation de l\'allowance Conditional Tokens...');
                await this.clobClient.updateBalanceAllowance({ asset_type: AssetType.CONDITIONAL });
                log.info('Allowance Conditional Tokens activée');
            }

        } catch (error) {
            log.warn('Erreur vérification allowance:', error.message);
            log.warn('Le trading peut échouer si l\'allowance n\'est pas configurée');
        }
    }

    // ========== MARCHÉS - Filtrage volume >= 1M ==========

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

    invalidateCache() {
        marketsCache = [];
        marketsCacheTime = 0;
    }

    // ========== ORDERBOOK - Analyse pour scalping ==========

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

    async analyzeBookForScalp(tokenId) {
        const book = await this.getOrderBook(tokenId);
        if (!book) return null;

        const bids = (book.bids || []).map(o => ({ price: parseFloat(o.price), size: parseFloat(o.size) }));
        const asks = (book.asks || []).map(o => ({ price: parseFloat(o.price), size: parseFloat(o.size) }));

        if (bids.length === 0 || asks.length === 0) return null;

        bids.sort((a, b) => b.price - a.price);
        asks.sort((a, b) => a.price - b.price);

        const bestBid = bids[0].price;
        const bestAsk = asks[0].price;
        const spreadCents = Math.round((bestAsk - bestBid) * 100);

        const bidDepthUsd = bids.slice(0, 5).reduce((s, o) => s + o.price * o.size, 0);
        const askDepthUsd = asks.slice(0, 5).reduce((s, o) => s + o.price * o.size, 0);

        const bestBidSize = bids[0].size;
        const bestAskSize = asks[0].size;

        const sellPrice = +(bestBid + CONFIG.SCALP_TICK).toFixed(2);
        const canSellAtTick = sellPrice <= bestAsk;

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

    async enrichForScalping(market) {
        const tokenIds = JSON.parse(market.clobTokenIds || '[]');
        if (tokenIds.length === 0) return null;

        const yesTokenId = tokenIds[0];
        const noTokenId = tokenIds.length > 1 ? tokenIds[1] : null;

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

    async placeFOKOrder({ tokenId, side, price, size }) {
        return this.placeOrder({ tokenId, side, price, size, orderType: 'FOK' });
    }

    /**
     * Vérifie si un ordre a été rempli (filled).
     * Retourne: { filled: bool, sizeMatched: number, status: string }
     */
    async checkOrderFill(orderId) {
        if (CONFIG.DRY_RUN) {
            return { filled: true, sizeMatched: 999, status: 'MATCHED' };
        }

        if (!this.clobClient) throw new Error('Client CLOB non initialisé');

        try {
            const order = await this.clobClient.getOrder(orderId);
            if (!order) return { filled: false, sizeMatched: 0, status: 'UNKNOWN' };

            const sizeMatched = parseFloat(order.size_matched || order.sizeMatched || '0');
            const originalSize = parseFloat(order.original_size || order.originalSize || order.size || '0');
            const status = order.status || 'UNKNOWN';

            // Un ordre est considéré rempli si size_matched > 0
            const filled = sizeMatched > 0;
            const fullyFilled = originalSize > 0 && sizeMatched >= originalSize * 0.95; // 95% tolérance

            return {
                filled,
                fullyFilled,
                sizeMatched,
                originalSize,
                status,
            };
        } catch (error) {
            log.error('Erreur check fill:', error.message);
            return { filled: false, sizeMatched: 0, status: 'ERROR' };
        }
    }

    /**
     * Attend qu'un ordre soit rempli avec polling.
     * @param {string} orderId
     * @param {number} timeoutMs - timeout en ms (défaut 10s)
     * @param {number} pollMs - intervalle de polling en ms (défaut 1s)
     * @returns {{ filled, sizeMatched, status }}
     */
    async waitForFill(orderId, timeoutMs = 10000, pollMs = 1000) {
        if (CONFIG.DRY_RUN) {
            return { filled: true, fullyFilled: true, sizeMatched: 999, status: 'MATCHED' };
        }

        const deadline = Date.now() + timeoutMs;
        let lastResult = null;

        while (Date.now() < deadline) {
            lastResult = await this.checkOrderFill(orderId);

            if (lastResult.filled) {
                return lastResult;
            }

            // Vérifier si l'ordre a été annulé
            if (lastResult.status === 'CANCELED' || lastResult.status === 'CANCELLED') {
                return lastResult;
            }

            await new Promise(r => setTimeout(r, pollMs));
        }

        return lastResult || { filled: false, sizeMatched: 0, status: 'TIMEOUT' };
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
     * Récupère le solde USDC du PROXY WALLET sur Polygon.
     * IMPORTANT: Les fonds Polymarket sont dans le proxy wallet, pas dans l'EOA.
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
            // USDC.e sur Polygon (utilisé par Polymarket)
            const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
            const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

            const { ethers } = require('ethers');
            const provider = new ethers.providers.JsonRpcProvider('https://polygon-rpc.com');
            const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);

            // Vérifier le solde du PROXY WALLET (pas l'EOA)
            const targetAddress = this.proxyWalletAddress || CONFIG.PROXY_WALLET_ADDRESS || CONFIG.WALLET_ADDRESS;
            const raw = await usdc.balanceOf(targetAddress);
            const balance = parseFloat(ethers.utils.formatUnits(raw, 6));

            this._balanceCache = balance;
            this._balanceCacheTime = now;
            log.info(`Proxy wallet balance: $${balance.toFixed(2)} USDC (${targetAddress})`);
            return balance;
        } catch (error) {
            log.error('Erreur balance:', error.message);
            return this._balanceCache || 0;
        }
    }

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
