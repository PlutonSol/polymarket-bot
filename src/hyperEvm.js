const { ethers } = require('ethers');
const CONFIG = require('./config');

// ABIs minimaux pour interagir avec les DEX UniswapV2-like
const UNISWAP_V2_ROUTER_ABI = [
    'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
    'function getAmountsIn(uint amountOut, address[] calldata path) external view returns (uint[] memory amounts)',
    'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
    'function swapTokensForExactTokens(uint amountOut, uint amountInMax, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
    'function WETH() external view returns (address)',
];

const UNISWAP_V2_FACTORY_ABI = [
    'function getPair(address tokenA, address tokenB) external view returns (address pair)',
    'function allPairs(uint) external view returns (address pair)',
    'function allPairsLength() external view returns (uint)',
];

const UNISWAP_V2_PAIR_ABI = [
    'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
    'function token0() external view returns (address)',
    'function token1() external view returns (address)',
    'function totalSupply() external view returns (uint)',
];

const ERC20_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
];

/**
 * Client pour interagir avec les DEX sur HyperEVM
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

        // Cache des paires, decimals, token0
        this.pairCache = new Map();
        this.decimalsCache = new Map();
        this.token0Cache = new Map();
        // Cache du gas price (refresh toutes les 10s)
        this.cachedGasPrice = null;
        this.gasPriceCacheTime = 0;
    }

    /**
     * Pré-approuve tous les tokens configurés pour le router au démarrage.
     * Élimine le délai d'approval pendant l'exécution d'arbitrage.
     */
    async preApproveTokens() {
        if (!this.wallet || !this.router || CONFIG.DRY_RUN) return;

        console.log('[EVM] Pre-approving tokens for router...');
        const tokensToApprove = [
            CONFIG.USDC_ADDRESS,
            ...CONFIG.TOKENS.map(t => t.evmAddress),
        ];

        const results = await Promise.allSettled(tokensToApprove.map(async (addr) => {
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

        for (const r of results) {
            if (r.status === 'rejected') {
                console.error('[EVM] Pre-approve error:', r.reason.message);
            }
        }
    }

    /**
     * Pré-charge les decimals et token0 pour tous les tokens configurés.
     * Élimine les appels RPC pendant le scan.
     */
    async warmupCaches() {
        console.log('[EVM] Warming up caches...');
        const allAddresses = [
            CONFIG.USDC_ADDRESS,
            ...CONFIG.TOKENS.map(t => t.evmAddress),
        ];

        // Charger tous les decimals en parallèle
        await Promise.allSettled(allAddresses.map(async (addr) => {
            const contract = new ethers.Contract(addr, ERC20_ABI, this.provider);
            const decimals = await contract.decimals();
            this.decimalsCache.set(addr.toLowerCase(), Number(decimals));
        }));

        // Charger les paires et token0 en parallèle
        await Promise.allSettled(CONFIG.TOKENS.map(async (token) => {
            const pairAddr = await this._getPairAddress(token.evmAddress, CONFIG.USDC_ADDRESS);
            if (pairAddr && pairAddr !== ethers.ZeroAddress) {
                const pair = new ethers.Contract(pairAddr, UNISWAP_V2_PAIR_ABI, this.provider);
                const token0 = await pair.token0();
                this.token0Cache.set(pairAddr.toLowerCase(), token0);
            }
        }));

        // Charger le gas price
        await this.getGasPrice();

        console.log(`[EVM] Cached ${this.decimalsCache.size} decimals, ${this.pairCache.size} pairs`);
    }

    /**
     * Récupère les decimals d'un token (depuis le cache si possible)
     */
    async _getDecimals(addr) {
        const key = addr.toLowerCase();
        if (this.decimalsCache.has(key)) return this.decimalsCache.get(key);
        const contract = new ethers.Contract(addr, ERC20_ABI, this.provider);
        const decimals = Number(await contract.decimals());
        this.decimalsCache.set(key, decimals);
        return decimals;
    }

    /**
     * Récupère le prix d'un token sur le DEX EVM via les réserves de la paire.
     * Optimisé: utilise le cache pour decimals et token0.
     */
    async getTokenPriceFromPair(tokenAddress) {
        const pairAddr = await this._getPairAddress(tokenAddress, CONFIG.USDC_ADDRESS);
        if (!pairAddr || pairAddr === ethers.ZeroAddress) return null;

        const pair = new ethers.Contract(pairAddr, UNISWAP_V2_PAIR_ABI, this.provider);

        // token0 depuis le cache, reserves toujours fraîches
        let token0 = this.token0Cache.get(pairAddr.toLowerCase());
        let reserves;
        if (token0) {
            reserves = await pair.getReserves();
        } else {
            [reserves, token0] = await Promise.all([
                pair.getReserves(),
                pair.token0(),
            ]);
            this.token0Cache.set(pairAddr.toLowerCase(), token0);
        }

        const isToken0 = token0.toLowerCase() === tokenAddress.toLowerCase();

        // Decimals depuis le cache
        const [tokenDecimals, usdcDecimals] = await Promise.all([
            this._getDecimals(tokenAddress),
            this._getDecimals(CONFIG.USDC_ADDRESS),
        ]);

        const tokenReserve = isToken0 ? reserves[0] : reserves[1];
        const usdcReserve = isToken0 ? reserves[1] : reserves[0];

        const tokenReserveFloat = parseFloat(ethers.formatUnits(tokenReserve, tokenDecimals));
        const usdcReserveFloat = parseFloat(ethers.formatUnits(usdcReserve, usdcDecimals));

        if (tokenReserveFloat === 0) return null;

        const price = usdcReserveFloat / tokenReserveFloat;

        return {
            price,
            tokenReserve: tokenReserveFloat,
            usdcReserve: usdcReserveFloat,
            liquidity: usdcReserveFloat * 2,
            pairAddress: pairAddr,
        };
    }

    /**
     * Simule un swap pour obtenir le prix effectif avec slippage
     */
    async getAmountsOut(amountIn, path) {
        if (!this.router) throw new Error('Router address not configured');
        try {
            const amounts = await this.router.getAmountsOut(amountIn, path);
            return amounts.map(a => a);
        } catch (e) {
            console.error('getAmountsOut error:', e.message);
            return null;
        }
    }

    /**
     * Calcule le prix effectif pour un montant donné (inclut le slippage AMM).
     * Optimisé: utilise le cache de decimals.
     */
    async getEffectivePrice(tokenAddress, amountUSDC, direction = 'buy') {
        if (!this.router) return null;

        const [usdcDecimals, tokenDecimals] = await Promise.all([
            this._getDecimals(CONFIG.USDC_ADDRESS),
            this._getDecimals(tokenAddress),
        ]);

        if (direction === 'buy') {
            const amountIn = ethers.parseUnits(amountUSDC.toString(), usdcDecimals);
            const path = [CONFIG.USDC_ADDRESS, tokenAddress];
            const amounts = await this.getAmountsOut(amountIn, path);
            if (!amounts) return null;

            const tokenOut = parseFloat(ethers.formatUnits(amounts[1], tokenDecimals));
            const effectivePrice = amountUSDC / tokenOut;

            return {
                amountIn: amountUSDC,
                amountOut: tokenOut,
                effectivePrice,
                priceImpact: 0,
            };
        } else {
            const spotData = await this.getTokenPriceFromPair(tokenAddress);
            if (!spotData) return null;

            const tokenAmount = amountUSDC / spotData.price;
            const amountIn = ethers.parseUnits(tokenAmount.toFixed(8), tokenDecimals);
            const path = [tokenAddress, CONFIG.USDC_ADDRESS];
            const amounts = await this.getAmountsOut(amountIn, path);
            if (!amounts) return null;

            const usdcOut = parseFloat(ethers.formatUnits(amounts[1], usdcDecimals));
            const effectivePrice = usdcOut / tokenAmount;

            return {
                amountIn: tokenAmount,
                amountOut: usdcOut,
                effectivePrice,
                priceImpact: ((spotData.price - effectivePrice) / spotData.price) * 100,
            };
        }
    }

    /**
     * Exécute un swap sur le DEX.
     * Optimisé: plus de check d'allowance (pré-approuvé au démarrage).
     */
    async executeSwap(tokenAddress, amountIn, minAmountOut, path) {
        if (!this.wallet) throw new Error('Wallet not configured');
        if (!this.router) throw new Error('Router not configured');

        if (CONFIG.DRY_RUN) {
            console.log('[DRY-RUN] EVM swap:', {
                tokenAddress,
                amountIn: amountIn.toString(),
                minAmountOut: minAmountOut.toString(),
                path,
            });
            return { status: 'dry-run', amountIn, minAmountOut };
        }

        // Deadline: 30 secondes (serré pour l'arb)
        const deadline = Math.floor(Date.now() / 1000) + 30;

        const tx = await this.router.swapExactTokensForTokens(
            amountIn,
            minAmountOut,
            path,
            this.wallet.address,
            deadline
        );

        console.log('Swap TX sent:', tx.hash);
        const receipt = await tx.wait();
        console.log('Swap confirmed in block:', receipt.blockNumber);

        return {
            status: 'confirmed',
            txHash: tx.hash,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString(),
        };
    }

    /**
     * Récupère les balances EVM du wallet
     */
    async getBalances(tokenAddresses) {
        if (!this.wallet) return {};

        const balances = {};
        const promises = tokenAddresses.map(async (addr) => {
            const contract = new ethers.Contract(addr, ERC20_ABI, this.provider);
            const [balance, decimals, symbol] = await Promise.all([
                contract.balanceOf(this.wallet.address),
                this._getDecimals(addr),
                contract.symbol(),
            ]);
            balances[symbol] = {
                raw: balance,
                formatted: parseFloat(ethers.formatUnits(balance, decimals)),
                decimals,
                address: addr,
            };
        });

        await Promise.all(promises);

        const nativeBalance = await this.provider.getBalance(this.wallet.address);
        balances['HYPE_NATIVE'] = {
            raw: nativeBalance,
            formatted: parseFloat(ethers.formatEther(nativeBalance)),
            decimals: 18,
        };

        return balances;
    }

    /**
     * Récupère le gas price actuel (cache de 10s)
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

    async _getPairContract(tokenA, tokenB) {
        const pairAddr = await this._getPairAddress(tokenA, tokenB);
        if (!pairAddr || pairAddr === ethers.ZeroAddress) return null;
        return new ethers.Contract(pairAddr, UNISWAP_V2_PAIR_ABI, this.provider);
    }

    async _getPairAddress(tokenA, tokenB) {
        const key = `${tokenA}-${tokenB}`.toLowerCase();
        if (this.pairCache.has(key)) return this.pairCache.get(key);

        if (!this.factory) return null;

        try {
            const pairAddr = await this.factory.getPair(tokenA, tokenB);
            this.pairCache.set(key, pairAddr);
            return pairAddr;
        } catch (e) {
            console.error('getPair error:', e.message);
            return null;
        }
    }
}

module.exports = HyperEvmClient;
