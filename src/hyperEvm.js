const { ethers } = require('ethers');
const CONFIG = require('./config');

const UNISWAP_V2_ROUTER_ABI = [
    'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
    'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
];

const UNISWAP_V2_FACTORY_ABI = [
    'function getPair(address tokenA, address tokenB) external view returns (address pair)',
];

const UNISWAP_V2_PAIR_ABI = [
    'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
    'function token0() external view returns (address)',
];

const ERC20_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
];

/**
 * Client HyperEVM optimisé pour HYPE uniquement.
 * Tous les contrats et constantes sont résolus une fois au warmup.
 */
class HyperEvmClient {
    constructor() {
        this.provider = new ethers.JsonRpcProvider(CONFIG.HYPERL_EVM_RPC);
        this.wallet = CONFIG.PRIVATE_KEY
            ? new ethers.Wallet(CONFIG.PRIVATE_KEY, this.provider)
            : null;

        this.router = CONFIG.DEX_ROUTER_ADDRESS
            ? new ethers.Contract(CONFIG.DEX_ROUTER_ADDRESS, UNISWAP_V2_ROUTER_ABI, this.wallet || this.provider)
            : null;

        this.factory = CONFIG.DEX_FACTORY_ADDRESS
            ? new ethers.Contract(CONFIG.DEX_FACTORY_ADDRESS, UNISWAP_V2_FACTORY_ABI, this.provider)
            : null;

        // Objets pré-résolus pour HYPE (chargés au warmup)
        this.hypePairContract = null;
        this.hypeIsToken0 = null;
        this.hypeDecimals = 18; // WHYPE = 18
        this.usdcDecimals = null;

        // Paths pré-construits
        this.pathBuyHype = [CONFIG.USDC_ADDRESS, CONFIG.WHYPE_ADDRESS];
        this.pathSellHype = [CONFIG.WHYPE_ADDRESS, CONFIG.USDC_ADDRESS];

        // Cache gas (refresh 10s)
        this.cachedGasPrice = null;
        this.gasPriceCacheTime = 0;

        // Nonce management pour TX parallèles
        this.pendingNonce = null;
    }

    /**
     * Warmup: résout tout une seule fois.
     * Après ça, getHypePrice() n'a besoin que de getReserves() (1 appel RPC).
     */
    async warmup() {
        console.log('[EVM] Warming up...');

        // Résoudre les decimals USDC
        const usdcContract = new ethers.Contract(CONFIG.USDC_ADDRESS, ERC20_ABI, this.provider);
        this.usdcDecimals = Number(await usdcContract.decimals());

        // Résoudre la paire HYPE/USDC
        if (this.factory) {
            const pairAddr = await this.factory.getPair(CONFIG.WHYPE_ADDRESS, CONFIG.USDC_ADDRESS);
            if (pairAddr && pairAddr !== ethers.ZeroAddress) {
                this.hypePairContract = new ethers.Contract(pairAddr, UNISWAP_V2_PAIR_ABI, this.provider);
                const token0 = await this.hypePairContract.token0();
                this.hypeIsToken0 = token0.toLowerCase() === CONFIG.WHYPE_ADDRESS.toLowerCase();
                console.log(`[EVM] HYPE pair: ${pairAddr} (HYPE is token${this.hypeIsToken0 ? '0' : '1'})`);
            } else {
                console.warn('[EVM] HYPE/USDC pair not found on DEX');
            }
        }

        // Charger le gas price
        await this.getGasPrice();

        // Initialiser le nonce
        if (this.wallet) {
            this.pendingNonce = await this.provider.getTransactionCount(this.wallet.address, 'pending');
        }

        console.log(`[EVM] Warmup done (USDC decimals: ${this.usdcDecimals})`);
    }

    /**
     * Pré-approuve WHYPE et USDC pour le router.
     */
    async preApproveTokens() {
        if (!this.wallet || !this.router || CONFIG.DRY_RUN) return;

        console.log('[EVM] Pre-approving tokens...');
        const tokens = [CONFIG.USDC_ADDRESS, CONFIG.WHYPE_ADDRESS];

        await Promise.allSettled(tokens.map(async (addr) => {
            const token = new ethers.Contract(addr, ERC20_ABI, this.wallet);
            const allowance = await token.allowance(this.wallet.address, CONFIG.DEX_ROUTER_ADDRESS);
            if (allowance < ethers.MaxUint256 / 2n) {
                const tx = await token.approve(CONFIG.DEX_ROUTER_ADDRESS, ethers.MaxUint256);
                await tx.wait();
                console.log(`[EVM] Approved ${addr}`);
            } else {
                console.log(`[EVM] Already approved ${addr}`);
            }
        }));
    }

    /**
     * Prix HYPE depuis les reserves de la paire.
     * Ultra-rapide: 1 seul appel RPC (getReserves), tout le reste est en cache.
     */
    async getHypePrice() {
        if (!this.hypePairContract) return null;

        const reserves = await this.hypePairContract.getReserves();

        const hypeReserve = this.hypeIsToken0 ? reserves[0] : reserves[1];
        const usdcReserve = this.hypeIsToken0 ? reserves[1] : reserves[0];

        const hypeFloat = parseFloat(ethers.formatUnits(hypeReserve, this.hypeDecimals));
        const usdcFloat = parseFloat(ethers.formatUnits(usdcReserve, this.usdcDecimals));

        if (hypeFloat === 0) return null;

        return {
            price: usdcFloat / hypeFloat,
            hypeReserve: hypeFloat,
            usdcReserve: usdcFloat,
            liquidity: usdcFloat * 2,
        };
    }

    /**
     * Prix effectif HYPE pour un montant donné (inclut slippage AMM).
     * Passe les réserves déjà récupérées pour éviter un double appel.
     */
    async getEffectivePrice(amountUSDC, direction, existingReserves) {
        if (!this.router) return null;

        if (direction === 'buy') {
            const amountIn = ethers.parseUnits(amountUSDC.toString(), this.usdcDecimals);
            const amounts = await this.router.getAmountsOut(amountIn, this.pathBuyHype);
            const hypeOut = parseFloat(ethers.formatUnits(amounts[1], this.hypeDecimals));
            const effectivePrice = amountUSDC / hypeOut;

            // Price impact calculé depuis les réserves
            const spotPrice = existingReserves
                ? existingReserves.usdcReserve / existingReserves.hypeReserve
                : effectivePrice;
            const priceImpact = ((effectivePrice - spotPrice) / spotPrice) * 100;

            return { amountOut: hypeOut, effectivePrice, priceImpact: Math.abs(priceImpact) };
        } else {
            const spotPrice = existingReserves
                ? existingReserves.usdcReserve / existingReserves.hypeReserve
                : null;
            if (!spotPrice) return null;

            const hypeAmount = amountUSDC / spotPrice;
            const amountIn = ethers.parseUnits(hypeAmount.toFixed(8), this.hypeDecimals);
            const amounts = await this.router.getAmountsOut(amountIn, this.pathSellHype);
            const usdcOut = parseFloat(ethers.formatUnits(amounts[1], this.usdcDecimals));
            const effectivePrice = usdcOut / hypeAmount;
            const priceImpact = ((spotPrice - effectivePrice) / spotPrice) * 100;

            return { amountOut: usdcOut, effectivePrice, priceImpact: Math.abs(priceImpact) };
        }
    }

    /**
     * Exécute un swap avec gestion du nonce pour les TX parallèles.
     */
    async executeSwap(amountIn, minAmountOut, path) {
        if (!this.wallet) throw new Error('Wallet not configured');
        if (!this.router) throw new Error('Router not configured');

        if (CONFIG.DRY_RUN) {
            console.log('[DRY-RUN] EVM swap:', {
                amountIn: amountIn.toString(),
                minAmountOut: minAmountOut.toString(),
                path,
            });
            return { status: 'dry-run', amountIn, minAmountOut };
        }

        const deadline = Math.floor(Date.now() / 1000) + 30;

        // Nonce géré manuellement pour les TX parallèles
        const nonce = this.pendingNonce;
        this.pendingNonce++;

        const tx = await this.router.swapExactTokensForTokens(
            amountIn,
            minAmountOut,
            path,
            this.wallet.address,
            deadline,
            { nonce }
        );

        console.log('Swap TX sent:', tx.hash);
        const receipt = await tx.wait();
        console.log('Swap confirmed block:', receipt.blockNumber);

        return {
            status: 'confirmed',
            txHash: tx.hash,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString(),
        };
    }

    /**
     * Récupère les balances HYPE + USDC du wallet
     */
    async getBalances() {
        if (!this.wallet) return null;

        const hypeContract = new ethers.Contract(CONFIG.WHYPE_ADDRESS, ERC20_ABI, this.provider);
        const usdcContract = new ethers.Contract(CONFIG.USDC_ADDRESS, ERC20_ABI, this.provider);

        const [hypeBalance, usdcBalance, nativeBalance] = await Promise.all([
            hypeContract.balanceOf(this.wallet.address),
            usdcContract.balanceOf(this.wallet.address),
            this.provider.getBalance(this.wallet.address),
        ]);

        return {
            hype: parseFloat(ethers.formatUnits(hypeBalance, this.hypeDecimals)),
            usdc: parseFloat(ethers.formatUnits(usdcBalance, this.usdcDecimals || 6)),
            nativeHype: parseFloat(ethers.formatEther(nativeBalance)),
        };
    }

    /**
     * Gas price avec cache 10s
     */
    async getGasPrice() {
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

    /**
     * Resync le nonce depuis la chain (après erreur)
     */
    async resyncNonce() {
        if (this.wallet) {
            this.pendingNonce = await this.provider.getTransactionCount(this.wallet.address, 'pending');
            console.log('[EVM] Nonce resynced:', this.pendingNonce);
        }
    }
}

module.exports = HyperEvmClient;
