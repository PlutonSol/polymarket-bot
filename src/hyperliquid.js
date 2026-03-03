const CONFIG = require('./config');

/**
 * Client pour l'API native Hyperliquid (L1 spot/perp)
 * Doc: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api
 */
class HyperliquidClient {
    constructor() {
        this.baseUrl = CONFIG.HYPERLIQUID_API;
        this.cachedMeta = null;
        this.cachedAssetMap = null;
    }

    /**
     * Requête POST générique vers l'API info
     */
    async postInfo(body) {
        const res = await fetch(`${this.baseUrl}/info`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            throw new Error(`Hyperliquid API error: ${res.status} ${res.statusText}`);
        }
        return res.json();
    }

    /**
     * Récupère les métadonnées de tous les assets spot
     */
    async getSpotMeta() {
        if (this.cachedMeta) return this.cachedMeta;
        const data = await this.postInfo({ type: 'spotMeta' });
        this.cachedMeta = data;
        return data;
    }

    /**
     * Récupère les prix mid de tous les assets spot
     * Retourne un objet { SYMBOL: { mid, bid, ask } }
     */
    async getAllSpotPrices() {
        const [meta, allMids] = await Promise.all([
            this.getSpotMeta(),
            this.postInfo({ type: 'allMids' }),
        ]);

        const prices = {};
        if (meta && meta.tokens) {
            for (const token of meta.tokens) {
                const symbol = token.name;
                // allMids retourne un objet avec les noms d'univers comme clés
                // Pour le spot, le format est "@<index>"
                const idx = token.index;
                const key = `@${idx}`;
                if (allMids && allMids[key]) {
                    prices[symbol] = {
                        mid: parseFloat(allMids[key]),
                        token,
                    };
                }
            }
        }
        return prices;
    }

    /**
     * Récupère le prix spot d'un token spécifique
     */
    async getSpotPrice(symbol) {
        const prices = await this.getAllSpotPrices();
        return prices[symbol] || null;
    }

    /**
     * Récupère le carnet d'ordres spot pour un token
     */
    async getSpotOrderBook(symbol) {
        const meta = await this.getSpotMeta();
        if (!meta || !meta.tokens) return null;

        const token = meta.tokens.find(t => t.name === symbol);
        if (!token) return null;

        const data = await this.postInfo({
            type: 'l2Book',
            coin: `@${token.index}`,
        });
        return data;
    }

    /**
     * Récupère le meilleur bid/ask pour un token spot
     */
    async getSpotBestBidAsk(symbol) {
        const book = await this.getSpotOrderBook(symbol);
        if (!book || !book.levels) return null;

        const [bids, asks] = book.levels;
        const bestBid = bids && bids.length > 0 ? parseFloat(bids[0].px) : null;
        const bestAsk = asks && asks.length > 0 ? parseFloat(asks[0].px) : null;
        const bidSize = bids && bids.length > 0 ? parseFloat(bids[0].sz) : 0;
        const askSize = asks && asks.length > 0 ? parseFloat(asks[0].sz) : 0;

        return { bestBid, bestAsk, bidSize, askSize };
    }

    /**
     * Récupère les prix perp (pour référence/hedge)
     */
    async getPerpMidPrices() {
        const data = await this.postInfo({ type: 'allMids' });
        const prices = {};
        if (data) {
            for (const [key, value] of Object.entries(data)) {
                if (!key.startsWith('@')) {
                    prices[key] = parseFloat(value);
                }
            }
        }
        return prices;
    }

    /**
     * Place un ordre spot via l'API exchange
     * Nécessite une signature avec la clé privée
     */
    async placeSpotOrder(params) {
        const { symbol, isBuy, size, price, orderType = 'Limit' } = params;

        const meta = await this.getSpotMeta();
        const token = meta.tokens.find(t => t.name === symbol);
        if (!token) throw new Error(`Token ${symbol} not found in spot meta`);

        // Construction de l'action d'ordre
        const action = {
            type: 'order',
            orders: [{
                a: token.index,
                b: isBuy,
                p: price.toString(),
                s: size.toString(),
                r: false, // reduce-only
                t: orderType === 'Limit'
                    ? { limit: { tif: 'Ioc' } }  // Immediate-or-Cancel pour arbitrage
                    : { trigger: { triggerPx: price.toString(), isMarket: true, tpsl: 'tp' } },
            }],
            grouping: 'na',
        };

        return this._signAndSend(action);
    }

    /**
     * Signe et envoie une action à l'API exchange
     */
    async _signAndSend(action) {
        // Pour l'instant, log seulement en dry-run
        if (CONFIG.DRY_RUN) {
            console.log('[DRY-RUN] Hyperliquid order:', JSON.stringify(action, null, 2));
            return { status: 'dry-run', action };
        }

        // L'implémentation réelle nécessite la signature EIP-712
        // avec la clé privée du wallet
        const { ethers } = require('ethers');
        const wallet = new ethers.Wallet(CONFIG.PRIVATE_KEY);

        // Hyperliquid utilise un schéma de signature spécifique
        // Voir: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint
        const timestamp = Date.now();
        const nonce = timestamp;

        const connectionId = Buffer.alloc(32);
        // L'implémentation complète de la signature EIP-712
        // est spécifique à Hyperliquid et nécessite le bon domain separator

        const payload = {
            action,
            nonce,
            signature: null, // À implémenter avec EIP-712
            vaultAddress: null,
        };

        const res = await fetch(`${this.baseUrl}/exchange`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        if (!res.ok) {
            const error = await res.text();
            throw new Error(`Hyperliquid exchange error: ${res.status} - ${error}`);
        }

        return res.json();
    }

    /**
     * Récupère les balances spot du wallet
     */
    async getSpotBalances(walletAddress) {
        const addr = walletAddress || CONFIG.WALLET_ADDRESS;
        const data = await this.postInfo({
            type: 'spotClearinghouseState',
            user: addr,
        });
        return data;
    }

    /**
     * Invalide le cache des métadonnées
     */
    clearCache() {
        this.cachedMeta = null;
        this.cachedAssetMap = null;
    }
}

module.exports = HyperliquidClient;
