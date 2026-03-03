const { ethers } = require('ethers');
const CONFIG = require('./config');

// EIP-712 domain pour Hyperliquid
const HL_DOMAIN = {
    name: 'Exchange',
    version: '1',
    chainId: 1337,
    verifyingContract: '0x0000000000000000000000000000000000000000',
};

const AGENT_TYPES = {
    Agent: [
        { name: 'source', type: 'string' },
        { name: 'connectionId', type: 'bytes32' },
    ],
};

/**
 * Client pour l'API native Hyperliquid (L1 spot/perp)
 */
class HyperliquidClient {
    constructor() {
        this.baseUrl = CONFIG.HYPERLIQUID_API;
        this.cachedMeta = null;
        // Pré-résoudre l'index du token HYPE pour éviter des lookups
        this.hypeIndex = null;
        // Wallet réutilisable (créé une seule fois)
        this.wallet = CONFIG.PRIVATE_KEY
            ? new ethers.Wallet(CONFIG.PRIVATE_KEY)
            : null;
    }

    /**
     * Requête POST avec timeout
     */
    async postInfo(body) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), CONFIG.FETCH_TIMEOUT_MS);

        try {
            const res = await fetch(`${this.baseUrl}/info`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            if (!res.ok) {
                throw new Error(`Hyperliquid API error: ${res.status} ${res.statusText}`);
            }
            return res.json();
        } finally {
            clearTimeout(timeout);
        }
    }

    /**
     * Récupère les métadonnées spot et pré-résout l'index HYPE
     */
    async getSpotMeta() {
        if (this.cachedMeta) return this.cachedMeta;
        const data = await this.postInfo({ type: 'spotMeta' });
        this.cachedMeta = data;

        // Pré-résoudre l'index HYPE
        if (data && data.tokens) {
            const hype = data.tokens.find(t => t.name === 'HYPE');
            if (hype) this.hypeIndex = hype.index;
        }

        return data;
    }

    /**
     * Récupère le best bid/ask pour HYPE (optimisé: un seul appel, pas de lookup)
     */
    async getHypeBestBidAsk() {
        if (this.hypeIndex === null) {
            await this.getSpotMeta();
        }
        if (this.hypeIndex === null) return null;

        const data = await this.postInfo({
            type: 'l2Book',
            coin: `@${this.hypeIndex}`,
        });

        if (!data || !data.levels) return null;

        const [bids, asks] = data.levels;
        const bestBid = bids && bids.length > 0 ? parseFloat(bids[0].px) : null;
        const bestAsk = asks && asks.length > 0 ? parseFloat(asks[0].px) : null;
        const bidSize = bids && bids.length > 0 ? parseFloat(bids[0].sz) : 0;
        const askSize = asks && asks.length > 0 ? parseFloat(asks[0].sz) : 0;

        return { bestBid, bestAsk, bidSize, askSize };
    }

    /**
     * Place un ordre spot HYPE via l'API exchange
     */
    async placeSpotOrder(params) {
        const { isBuy, size, price } = params;

        if (this.hypeIndex === null) {
            await this.getSpotMeta();
        }
        if (this.hypeIndex === null) {
            throw new Error('HYPE token not found in spot meta');
        }

        const action = {
            type: 'order',
            orders: [{
                a: this.hypeIndex,
                b: isBuy,
                p: price.toString(),
                s: size.toString(),
                r: false,
                t: { limit: { tif: 'Ioc' } },
            }],
            grouping: 'na',
        };

        return this._signAndSend(action);
    }

    /**
     * Signe et envoie une action à l'API exchange avec EIP-712
     */
    async _signAndSend(action) {
        if (CONFIG.DRY_RUN) {
            console.log('[DRY-RUN] HL order:', JSON.stringify(action));
            return { status: 'dry-run', action };
        }

        if (!this.wallet) {
            throw new Error('PRIVATE_KEY not configured, cannot sign');
        }

        const timestamp = Date.now();
        const nonce = timestamp;

        // Signer avec EIP-712 selon le protocole Hyperliquid
        const connectionId = ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(
                ['string', 'uint64'],
                [JSON.stringify(action), nonce]
            )
        );

        const signature = await this.wallet.signTypedData(
            HL_DOMAIN,
            AGENT_TYPES,
            {
                source: 'a',
                connectionId,
            }
        );

        const payload = {
            action,
            nonce,
            signature,
            vaultAddress: null,
        };

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), CONFIG.FETCH_TIMEOUT_MS);

        try {
            const res = await fetch(`${this.baseUrl}/exchange`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });

            if (!res.ok) {
                const error = await res.text();
                throw new Error(`Hyperliquid exchange error: ${res.status} - ${error}`);
            }

            return res.json();
        } finally {
            clearTimeout(timeout);
        }
    }

    /**
     * Récupère les balances spot du wallet
     */
    async getSpotBalances(walletAddress) {
        const addr = walletAddress || CONFIG.WALLET_ADDRESS;
        if (!addr) return null;
        return this.postInfo({
            type: 'spotClearinghouseState',
            user: addr,
        });
    }

    clearCache() {
        this.cachedMeta = null;
        this.hypeIndex = null;
    }
}

module.exports = HyperliquidClient;
