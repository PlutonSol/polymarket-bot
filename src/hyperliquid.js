const { ethers } = require('ethers');
const CONFIG = require('./config');

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
 * Client Hyperliquid optimisé.
 * - Wallet créé une seule fois
 * - Index HYPE pré-résolu
 * - HTTP keep-alive implicite (Node.js fetch)
 * - Timeout court sur toutes les requêtes
 */
class HyperliquidClient {
    constructor() {
        this.baseUrl = CONFIG.HYPERLIQUID_API;
        this.cachedMeta = null;
        this.hypeIndex = null;
        this.wallet = CONFIG.PRIVATE_KEY
            ? new ethers.Wallet(CONFIG.PRIVATE_KEY)
            : null;
    }

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
            if (!res.ok) throw new Error(`HL API ${res.status}`);
            return res.json();
        } finally {
            clearTimeout(timeout);
        }
    }

    async getSpotMeta() {
        if (this.cachedMeta) return this.cachedMeta;
        const data = await this.postInfo({ type: 'spotMeta' });
        this.cachedMeta = data;
        if (data && data.tokens) {
            const hype = data.tokens.find(t => t.name === 'HYPE');
            if (hype) this.hypeIndex = hype.index;
        }
        return data;
    }

    /**
     * Best bid/ask HYPE. Un seul HTTP POST (~50-80ms).
     */
    async getHypeBestBidAsk() {
        if (this.hypeIndex === null) await this.getSpotMeta();
        if (this.hypeIndex === null) return null;

        const data = await this.postInfo({
            type: 'l2Book',
            coin: `@${this.hypeIndex}`,
        });

        if (!data || !data.levels) return null;
        const [bids, asks] = data.levels;
        return {
            bestBid: bids && bids.length > 0 ? parseFloat(bids[0].px) : null,
            bestAsk: asks && asks.length > 0 ? parseFloat(asks[0].px) : null,
            bidSize: bids && bids.length > 0 ? parseFloat(bids[0].sz) : 0,
            askSize: asks && asks.length > 0 ? parseFloat(asks[0].sz) : 0,
        };
    }

    /**
     * Place un ordre IOC et retourne le résultat.
     * Sign EIP-712 (~5ms local) + HTTP POST (~80ms).
     */
    async placeSpotOrder(params) {
        const { isBuy, size, price } = params;
        if (this.hypeIndex === null) await this.getSpotMeta();
        if (this.hypeIndex === null) throw new Error('HYPE not found');

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

    async _signAndSend(action) {
        if (CONFIG.DRY_RUN) {
            console.log('[DRY-RUN] HL order:', JSON.stringify(action));
            return { status: 'dry-run', action };
        }

        if (!this.wallet) throw new Error('PRIVATE_KEY not configured');

        const nonce = Date.now();

        const connectionId = ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(
                ['string', 'uint64'],
                [JSON.stringify(action), nonce]
            )
        );

        const signature = await this.wallet.signTypedData(
            HL_DOMAIN,
            AGENT_TYPES,
            { source: 'a', connectionId }
        );

        const payload = { action, nonce, signature, vaultAddress: null };

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
                const err = await res.text();
                throw new Error(`HL exchange ${res.status}: ${err}`);
            }
            return res.json();
        } finally {
            clearTimeout(timeout);
        }
    }

    async getSpotBalances(walletAddress) {
        const addr = walletAddress || CONFIG.WALLET_ADDRESS;
        if (!addr) return null;
        return this.postInfo({ type: 'spotClearinghouseState', user: addr });
    }

    clearCache() {
        this.cachedMeta = null;
        this.hypeIndex = null;
    }
}

module.exports = HyperliquidClient;
