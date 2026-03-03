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

        // Cache des paires
        this.pairCache = new Map();
    }

    /**
     * Récupère le prix d'un token sur le DEX EVM via les réserves de la paire
     * Retourne le prix en USDC
     */
    async getTokenPriceFromPair(tokenAddress) {
        const pair = await this._getPairContract(tokenAddress, CONFIG.USDC_ADDRESS);
        if (!pair) return null;

        const [reserves, token0] = await Promise.all([
            pair.getReserves(),
            pair.token0(),
        ]);

        const reserve0 = reserves[0];
        const reserve1 = reserves[1];

        // Déterminer quel token est token0 et token1
        const isToken0 = token0.toLowerCase() === tokenAddress.toLowerCase();

        // Token decimals
        const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
        const usdcContract = new ethers.Contract(CONFIG.USDC_ADDRESS, ERC20_ABI, this.provider);
        const [tokenDecimals, usdcDecimals] = await Promise.all([
            tokenContract.decimals(),
            usdcContract.decimals(),
        ]);

        let tokenReserve, usdcReserve;
        if (isToken0) {
            tokenReserve = reserve0;
            usdcReserve = reserve1;
        } else {
            tokenReserve = reserve1;
            usdcReserve = reserve0;
        }

        // Prix = usdcReserve / tokenReserve (ajusté pour les decimals)
        const tokenReserveFloat = parseFloat(ethers.formatUnits(tokenReserve, tokenDecimals));
        const usdcReserveFloat = parseFloat(ethers.formatUnits(usdcReserve, usdcDecimals));

        if (tokenReserveFloat === 0) return null;

        const price = usdcReserveFloat / tokenReserveFloat;

        return {
            price,
            tokenReserve: tokenReserveFloat,
            usdcReserve: usdcReserveFloat,
            liquidity: usdcReserveFloat * 2,
            pairAddress: await this._getPairAddress(tokenAddress, CONFIG.USDC_ADDRESS),
        };
    }

    /**
     * Simule un swap pour obtenir le prix effectif avec slippage
     * amountIn en USDC pour acheter le token, ou en token pour vendre
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
     * Calcule le prix effectif pour un montant donné (inclut le slippage AMM)
     * direction: 'buy' = USDC -> Token, 'sell' = Token -> USDC
     */
    async getEffectivePrice(tokenAddress, amountUSDC, direction = 'buy') {
        if (!this.router) return null;

        const usdcContract = new ethers.Contract(CONFIG.USDC_ADDRESS, ERC20_ABI, this.provider);
        const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
        const [usdcDecimals, tokenDecimals] = await Promise.all([
            usdcContract.decimals(),
            tokenContract.decimals(),
        ]);

        if (direction === 'buy') {
            // USDC -> Token : combien de tokens pour X USDC
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
                priceImpact: 0, // Calculé séparément
            };
        } else {
            // Token -> USDC : combien de USDC pour X tokens
            // D'abord calculer combien de tokens correspondent à amountUSDC au prix spot
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
     * Exécute un swap sur le DEX
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

        // Vérifier et approuver si nécessaire
        const tokenIn = new ethers.Contract(path[0], ERC20_ABI, this.wallet);
        const allowance = await tokenIn.allowance(this.wallet.address, CONFIG.DEX_ROUTER_ADDRESS);

        if (allowance < amountIn) {
            console.log('Approving token spend...');
            const approveTx = await tokenIn.approve(
                CONFIG.DEX_ROUTER_ADDRESS,
                ethers.MaxUint256
            );
            await approveTx.wait();
            console.log('Approval confirmed');
        }

        // Deadline: 2 minutes
        const deadline = Math.floor(Date.now() / 1000) + 120;

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
                contract.decimals(),
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

        // Balance native (HYPE)
        const nativeBalance = await this.provider.getBalance(this.wallet.address);
        balances['HYPE_NATIVE'] = {
            raw: nativeBalance,
            formatted: parseFloat(ethers.formatEther(nativeBalance)),
            decimals: 18,
        };

        return balances;
    }

    /**
     * Récupère le gas price actuel
     */
    async getGasPrice() {
        const feeData = await this.provider.getFeeData();
        return {
            gasPrice: feeData.gasPrice,
            gasPriceGwei: parseFloat(ethers.formatUnits(feeData.gasPrice || 0n, 'gwei')),
        };
    }

    /**
     * Récupère le contrat de paire pour deux tokens
     */
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
