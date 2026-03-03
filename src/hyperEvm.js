const { ethers } = require('ethers');
const CONFIG = require('./config');

const ROUTER_ABI = [
    'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
];

const FACTORY_ABI = [
    'function getPair(address tokenA, address tokenB) external view returns (address pair)',
];

const PAIR_ABI = [
    'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
    'function token0() external view returns (address)',
];

const ERC20_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
];

// Pré-calculer l'interface pour encoder le calldata sans passer par Contract
const ROUTER_IFACE = new ethers.Interface(ROUTER_ABI);

/**
 * Client HyperEVM ultra-rapide pour HYPE.
 *
 * Architecture sub-2s:
 * - WebSocket provider pour block events instantanés
 * - Tous les contrats/constantes résolus au warmup
 * - getHypePrice(): 1 seul RPC (getReserves)
 * - AMM math locale (pas de getAmountsOut RPC)
 * - fireSwap(): envoie TX et retourne immédiatement (pas de tx.wait)
 * - Calldata pré-encodé + gas limit fixe (pas de estimateGas)
 * - Pending TX tracker en arrière-plan
 */
class HyperEvmClient {
    constructor() {
        // Provider principal (WS si disponible, sinon HTTP)
        this.provider = null;
        this.wsProvider = null;
        this.httpProvider = new ethers.JsonRpcProvider(CONFIG.HYPERL_EVM_RPC);

        this.wallet = null;

        // Objets pré-résolus (warmup)
        this.hypePairContract = null;
        this.hypeIsToken0 = null;
        this.hypeDecimals = 18;
        this.usdcDecimals = null;
        this.pathBuyHype = [CONFIG.USDC_ADDRESS, CONFIG.WHYPE_ADDRESS];
        this.pathSellHype = [CONFIG.WHYPE_ADDRESS, CONFIG.USDC_ADDRESS];

        // Cache gas (refresh 10s)
        this.cachedGasPrice = null;
        this.gasPriceCacheTime = 0;

        // Nonce management
        this.pendingNonce = null;

        // Pending TX tracker
        this.pendingTxs = [];

        // Block subscription callback
        this._blockCallback = null;
    }

    /**
     * Initialise les providers (WS + HTTP fallback).
     * WS pour les block events, HTTP comme fallback.
     */
    async initProviders() {
        // Tenter le WebSocket pour les block events temps-réel
        const wsUrl = CONFIG.HYPERL_EVM_WS ||
            CONFIG.HYPERL_EVM_RPC.replace('https://', 'wss://').replace('http://', 'ws://');

        try {
            this.wsProvider = new ethers.WebSocketProvider(wsUrl);
            // Attendre que la connexion WS soit établie
            await this.wsProvider.getBlockNumber();
            this.provider = this.wsProvider;
            console.log('[EVM] WebSocket provider connected');
        } catch (e) {
            console.log(`[EVM] WebSocket failed (${e.message}), using HTTP polling`);
            this.provider = this.httpProvider;
        }

        if (CONFIG.PRIVATE_KEY) {
            this.wallet = new ethers.Wallet(CONFIG.PRIVATE_KEY, this.provider);
        }
    }

    /**
     * Souscrit aux nouveaux blocs. Déclenche le callback dès qu'un bloc arrive.
     * WS: événement instantané. HTTP fallback: poll toutes les 500ms.
     */
    onNewBlock(callback) {
        this._blockCallback = callback;

        const provider = this.wsProvider || this.provider;
        provider.on('block', (blockNumber) => {
            callback(blockNumber);
        });

        // Si HTTP, réduire l'intervalle de polling
        if (!this.wsProvider && this.provider.pollingInterval) {
            this.provider.pollingInterval = 500;
        }
    }

    /**
     * Warmup: résout tout une seule fois.
     * Après ça, chaque scan = 1 seul RPC (getReserves).
     */
    async warmup() {
        console.log('[EVM] Warming up...');

        await this.initProviders();

        // Résoudre USDC decimals
        const usdcContract = new ethers.Contract(CONFIG.USDC_ADDRESS, ERC20_ABI, this.provider);
        this.usdcDecimals = Number(await usdcContract.decimals());

        // Résoudre la paire HYPE/USDC
        if (CONFIG.DEX_FACTORY_ADDRESS) {
            const factory = new ethers.Contract(CONFIG.DEX_FACTORY_ADDRESS, FACTORY_ABI, this.provider);
            const pairAddr = await factory.getPair(CONFIG.WHYPE_ADDRESS, CONFIG.USDC_ADDRESS);
            if (pairAddr && pairAddr !== ethers.ZeroAddress) {
                this.hypePairContract = new ethers.Contract(pairAddr, PAIR_ABI, this.provider);
                const token0 = await this.hypePairContract.token0();
                this.hypeIsToken0 = token0.toLowerCase() === CONFIG.WHYPE_ADDRESS.toLowerCase();
                console.log(`[EVM] Pair: ${pairAddr} (HYPE=token${this.hypeIsToken0 ? '0' : '1'})`);
            } else {
                console.warn('[EVM] HYPE/USDC pair not found');
            }
        }

        // Gas + nonce
        await this.refreshGasPrice();
        if (this.wallet) {
            this.pendingNonce = await this.provider.getTransactionCount(this.wallet.address, 'pending');
        }

        console.log(`[EVM] Ready (USDC=${this.usdcDecimals}dec, nonce=${this.pendingNonce})`);
    }

    async preApproveTokens() {
        if (!this.wallet || !CONFIG.DEX_ROUTER_ADDRESS || CONFIG.DRY_RUN) return;

        console.log('[EVM] Pre-approving...');
        for (const addr of [CONFIG.USDC_ADDRESS, CONFIG.WHYPE_ADDRESS]) {
            const token = new ethers.Contract(addr, ERC20_ABI, this.wallet);
            const allowance = await token.allowance(this.wallet.address, CONFIG.DEX_ROUTER_ADDRESS);
            if (allowance < ethers.MaxUint256 / 2n) {
                const tx = await token.approve(CONFIG.DEX_ROUTER_ADDRESS, ethers.MaxUint256);
                await tx.wait();
                console.log(`[EVM] Approved ${addr}`);
            }
        }
    }

    /**
     * Prix HYPE: 1 seul appel RPC (getReserves).
     * Retourne aussi les réserves brutes pour le calcul AMM local.
     */
    async getHypePrice() {
        if (!this.hypePairContract) return null;

        const reserves = await this.hypePairContract.getReserves();

        const rawHype = this.hypeIsToken0 ? reserves[0] : reserves[1];
        const rawUsdc = this.hypeIsToken0 ? reserves[1] : reserves[0];

        const hypeFloat = parseFloat(ethers.formatUnits(rawHype, this.hypeDecimals));
        const usdcFloat = parseFloat(ethers.formatUnits(rawUsdc, this.usdcDecimals));

        if (hypeFloat === 0) return null;

        return {
            price: usdcFloat / hypeFloat,
            hypeReserve: hypeFloat,
            usdcReserve: usdcFloat,
            liquidity: usdcFloat * 2,
            // Réserves brutes BigInt pour le calcul AMM précis
            rawHypeReserve: rawHype,
            rawUsdcReserve: rawUsdc,
        };
    }

    /**
     * Calcul AMM LOCAL (UniswapV2).
     * ZERO appel RPC. Utilise les réserves déjà récupérées.
     *
     * Formule: amountOut = (amountIn * 997 * reserveOut) / (reserveIn * 1000 + amountIn * 997)
     */
    computeEffectivePrice(amountUSDC, reserves, direction) {
        const fee = CONFIG.AMM_FEE_NUMERATOR;   // 997
        const base = CONFIG.AMM_FEE_DENOMINATOR; // 1000

        if (direction === 'buy') {
            // USDC → HYPE
            const amountInWithFee = amountUSDC * fee;
            const numerator = amountInWithFee * reserves.hypeReserve;
            const denominator = reserves.usdcReserve * base + amountInWithFee;
            const hypeOut = numerator / denominator;
            const effectivePrice = amountUSDC / hypeOut;
            const spotPrice = reserves.price;
            const priceImpact = Math.abs((effectivePrice - spotPrice) / spotPrice) * 100;
            return { amountOut: hypeOut, effectivePrice, priceImpact };
        } else {
            // HYPE → USDC
            const hypeIn = amountUSDC / reserves.price;
            const amountInWithFee = hypeIn * fee;
            const numerator = amountInWithFee * reserves.usdcReserve;
            const denominator = reserves.hypeReserve * base + amountInWithFee;
            const usdcOut = numerator / denominator;
            const effectivePrice = usdcOut / hypeIn;
            const spotPrice = reserves.price;
            const priceImpact = Math.abs((spotPrice - effectivePrice) / spotPrice) * 100;
            return { amountOut: usdcOut, effectivePrice, priceImpact };
        }
    }

    /**
     * FIRE-AND-FORGET swap.
     *
     * Retourne dès que la TX est dans le mempool (~50-100ms).
     * PAS de tx.wait() = PAS d'attente de confirmation.
     *
     * Optimisations:
     * - Calldata pré-encodé (pas d'abstraction Contract)
     * - Gas limit fixe (pas de estimateGas RPC)
     * - Gas price depuis le cache (pas de getFeeData RPC)
     * - Nonce géré localement (pas de getTransactionCount RPC)
     *
     * Seul appel RPC: eth_sendRawTransaction
     */
    async fireSwap(amountIn, minAmountOut, path) {
        if (!this.wallet) throw new Error('Wallet not configured');
        if (!CONFIG.DEX_ROUTER_ADDRESS) throw new Error('Router not configured');

        if (CONFIG.DRY_RUN) {
            console.log('[DRY-RUN] EVM swap:', {
                amountIn: amountIn.toString(),
                minAmountOut: minAmountOut.toString(),
                path,
            });
            return { status: 'dry-run', txHash: 'dry-run' };
        }

        const deadline = Math.floor(Date.now() / 1000) + 30;

        // Encoder le calldata directement (pas de Contract.method())
        const data = ROUTER_IFACE.encodeFunctionData('swapExactTokensForTokens', [
            amountIn,
            minAmountOut,
            path,
            this.wallet.address,
            deadline,
        ]);

        const nonce = this.pendingNonce;
        this.pendingNonce++;

        // Gas depuis le cache (pas de RPC)
        const gasPrice = this.cachedGasPrice ? this.cachedGasPrice.gasPrice : undefined;

        // Envoyer: seul appel RPC = eth_sendRawTransaction
        const tx = await this.wallet.sendTransaction({
            to: CONFIG.DEX_ROUTER_ADDRESS,
            data,
            gasLimit: BigInt(CONFIG.FIXED_GAS_LIMIT),
            gasPrice,
            nonce,
        });

        console.log(`[EVM] TX fired: ${tx.hash} (nonce=${nonce})`);

        // Tracker en arrière-plan
        this.pendingTxs.push({
            txHash: tx.hash,
            nonce,
            sentAt: Date.now(),
            tx,
        });

        return { status: 'sent', txHash: tx.hash };
    }

    /**
     * Vérifie les TX en attente. Appelé à chaque bloc.
     * Non-bloquant pour le scan principal.
     */
    async checkPendingTxs() {
        if (this.pendingTxs.length === 0) return [];

        const results = [];
        const stillPending = [];

        for (const pending of this.pendingTxs) {
            try {
                const receipt = await this.provider.getTransactionReceipt(pending.txHash);
                if (receipt) {
                    const confirmed = receipt.status === 1;
                    const confirmMs = Date.now() - pending.sentAt;
                    results.push({
                        txHash: pending.txHash,
                        confirmed,
                        blockNumber: receipt.blockNumber,
                        gasUsed: receipt.gasUsed.toString(),
                        confirmMs,
                    });
                    console.log(`[EVM] TX ${confirmed ? '✅' : '❌'} ${pending.txHash.slice(0, 10)}... (${confirmMs}ms)`);
                } else if (Date.now() - pending.sentAt > CONFIG.TX_STUCK_TIMEOUT_MS) {
                    console.error(`[EVM] TX stuck: ${pending.txHash} (${((Date.now() - pending.sentAt) / 1000).toFixed(1)}s)`);
                    results.push({ txHash: pending.txHash, confirmed: false, stuck: true });
                } else {
                    stillPending.push(pending);
                }
            } catch (e) {
                stillPending.push(pending);
            }
        }

        this.pendingTxs = stillPending;
        return results;
    }

    async refreshGasPrice() {
        const now = Date.now();
        if (this.cachedGasPrice && (now - this.gasPriceCacheTime) < 10000) {
            return this.cachedGasPrice;
        }
        const feeData = await this.provider.getFeeData();
        this.cachedGasPrice = {
            gasPrice: feeData.gasPrice,
            gasPriceGwei: parseFloat(ethers.formatUnits(feeData.gasPrice || 0n, 'gwei')),
        };
        this.gasPriceCacheTime = now;
        return this.cachedGasPrice;
    }

    async getBalances() {
        if (!this.wallet) return null;
        const hypeC = new ethers.Contract(CONFIG.WHYPE_ADDRESS, ERC20_ABI, this.provider);
        const usdcC = new ethers.Contract(CONFIG.USDC_ADDRESS, ERC20_ABI, this.provider);
        const [hBal, uBal, nBal] = await Promise.all([
            hypeC.balanceOf(this.wallet.address),
            usdcC.balanceOf(this.wallet.address),
            this.provider.getBalance(this.wallet.address),
        ]);
        return {
            hype: parseFloat(ethers.formatUnits(hBal, this.hypeDecimals)),
            usdc: parseFloat(ethers.formatUnits(uBal, this.usdcDecimals || 6)),
            nativeHype: parseFloat(ethers.formatEther(nBal)),
        };
    }

    async resyncNonce() {
        if (this.wallet) {
            this.pendingNonce = await this.provider.getTransactionCount(this.wallet.address, 'pending');
            console.log('[EVM] Nonce resynced:', this.pendingNonce);
        }
    }

    async destroy() {
        if (this.wsProvider) {
            await this.wsProvider.destroy();
        }
    }
}

module.exports = HyperEvmClient;
