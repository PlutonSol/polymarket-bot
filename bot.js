require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    // Wallet à surveiller
    TARGET_WALLET: '0x594edb9112f526fa6a80b8f858a6379c8a2c1c11',
    
    // Telegram
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '8525426243:AAHfQdqz1jUD4algSX15z2SHvsziOG0rxxs',
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '410866851',
    
    // Intervalle de vérification (en ms)
    CHECK_INTERVAL: 15000, // 15 secondes
};

// ============================================
// VARIABLES GLOBALES
// ============================================
let telegramBot;
let isRunning = false;
let knownTrades = new Set(); // Pour éviter les doublons
let lastCheck = Date.now();

// ============================================
// INITIALISATION
// ============================================
async function init() {
    console.log('🚀 Initialisation du bot de notifications Polymarket...\n');
    
    // Initialiser Telegram
    telegramBot = new TelegramBot(CONFIG.TELEGRAM_BOT_TOKEN, { polling: true });
    setupTelegramCommands();
    
    console.log('✅ Bot initialisé avec succès!\n');
    console.log('📊 Configuration:');
    console.log(`   Wallet surveillé: ${CONFIG.TARGET_WALLET}`);
    console.log(`   Intervalle: ${CONFIG.CHECK_INTERVAL / 1000}s`);
    console.log('');
    
    // Envoyer message Telegram
    await sendTelegram(`🤖 *Bot Polymarket Notifications démarré*

📊 *Configuration:*
• Wallet surveillé: \`${shortenAddress(CONFIG.TARGET_WALLET)}\`
• Intervalle: ${CONFIG.CHECK_INTERVAL / 1000}s

Commandes:
/start\\_watch - Démarrer la surveillance
/stop\\_watch - Arrêter la surveillance
/status - Voir le statut
/check - Vérifier maintenant`);
    
    return true;
}

// ============================================
// FONCTIONS TELEGRAM
// ============================================
function setupTelegramCommands() {
    telegramBot.onText(/\/start_watch/, async (msg) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;
        
        if (isRunning) {
            await sendTelegram('⚠️ La surveillance est déjà active');
            return;
        }
        
        isRunning = true;
        await sendTelegram('🟢 *Surveillance activée!*\n\nJe t\'enverrai une notification à chaque trade.');
        startWatching();
    });
    
    telegramBot.onText(/\/stop_watch/, async (msg) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;
        
        isRunning = false;
        await sendTelegram('🔴 *Surveillance arrêtée*');
    });
    
    telegramBot.onText(/\/status/, async (msg) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;
        
        const status = isRunning ? '🟢 Active' : '🔴 Arrêtée';
        await sendTelegram(`📊 *Statut du bot*

État: ${status}
Wallet surveillé: \`${shortenAddress(CONFIG.TARGET_WALLET)}\`
Trades détectés: ${knownTrades.size}`);
    });
    
    telegramBot.onText(/\/check/, async (msg) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;
        
        await sendTelegram('🔍 Vérification en cours...');
        await checkTrades(true);
    });
    
    telegramBot.onText(/\/help/, async (msg) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;
        
        await sendTelegram(`🤖 *Commandes disponibles:*

/start\\_watch - Démarrer la surveillance
/stop\\_watch - Arrêter la surveillance
/status - Voir le statut
/check - Vérifier maintenant
/help - Afficher cette aide`);
    });
}

async function sendTelegram(message) {
    try {
        await telegramBot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Erreur Telegram:', error.message);
    }
}

// ============================================
// FONCTIONS UTILITAIRES
// ============================================
function shortenAddress(address) {
    if (!address) return '';
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// ============================================
// SURVEILLANCE DES TRADES
// ============================================
async function fetchRecentTrades() {
    try {
        // API Polymarket pour les trades récents
        const response = await fetch(
            `https://data-api.polymarket.com/trades?user=${CONFIG.TARGET_WALLET.toLowerCase()}&limit=20`
        );
        
        if (response.ok) {
            return await response.json();
        }
        
        // Fallback API gamma
        const gammaResponse = await fetch(
            `https://gamma-api.polymarket.com/trades?user=${CONFIG.TARGET_WALLET.toLowerCase()}&limit=20`
        );
        
        if (gammaResponse.ok) {
            return await gammaResponse.json();
        }
        
        return null;
    } catch (error) {
        console.error('Erreur fetch trades:', error.message);
        return null;
    }
}

async function fetchMarketInfo(conditionId) {
    try {
        const response = await fetch(
            `https://gamma-api.polymarket.com/markets?condition_id=${conditionId}`
        );
        
        if (response.ok) {
            const data = await response.json();
            return data[0] || null;
        }
        return null;
    } catch (error) {
        return null;
    }
}

async function startWatching() {
    console.log('🔄 Démarrage de la surveillance...\n');
    
    // Charger les trades existants pour ne pas spammer
    const initialTrades = await fetchRecentTrades();
    if (initialTrades && Array.isArray(initialTrades)) {
        for (const trade of initialTrades) {
            const tradeId = trade.id || `${trade.timestamp}-${trade.asset_id}`;
            knownTrades.add(tradeId);
        }
        console.log(`📊 ${knownTrades.size} trades existants chargés`);
    }
    
    // Boucle de surveillance
    while (isRunning) {
        try {
            await checkTrades(false);
        } catch (error) {
            console.error('Erreur dans la boucle:', error.message);
        }
        
        await sleep(CONFIG.CHECK_INTERVAL);
    }
}

async function checkTrades(forceNotify) {
    const trades = await fetchRecentTrades();
    
    if (!trades || !Array.isArray(trades)) {
        if (forceNotify) {
            await sendTelegram('❌ Impossible de récupérer les trades');
        }
        return;
    }
    
    let newTradesCount = 0;
    
    for (const trade of trades) {
        const tradeId = trade.id || `${trade.timestamp}-${trade.asset_id}`;
        
        // Vérifier si c'est un nouveau trade
        if (!knownTrades.has(tradeId)) {
            knownTrades.add(tradeId);
            newTradesCount++;
            
            // Récupérer les infos du marché
            const marketInfo = await fetchMarketInfo(trade.condition_id || trade.market);
            const marketName = marketInfo?.question || trade.market || 'Marché inconnu';
            const outcome = trade.outcome || trade.side || 'N/A';
            
            const isBuy = (trade.side === 'BUY' || trade.side === 'buy' || trade.type === 'buy');
            const emoji = isBuy ? '🟢 ACHAT' : '🔴 VENTE';
            
            const price = parseFloat(trade.price || 0).toFixed(2);
            const size = parseFloat(trade.size || trade.amount || 0).toFixed(2);
            const total = (parseFloat(trade.price || 0) * parseFloat(trade.size || trade.amount || 0)).toFixed(2);
            
            const timestamp = trade.timestamp ? new Date(trade.timestamp).toLocaleString('fr-FR') : 'N/A';
            
            // Envoyer notification
            await sendTelegram(`🔔 *Nouveau Trade Détecté!*

${emoji}

📊 *Marché:* ${marketName}

💰 *Détails:*
• Position: ${outcome}
• Prix: $${price}
• Quantité: ${size}
• Total: $${total}

⏰ ${timestamp}

👀 [Voir le wallet](https://polymarket.com/profile/${CONFIG.TARGET_WALLET})`);
            
            console.log(`📈 Nouveau trade: ${emoji} - ${marketName} - $${total}`);
        }
    }
    
    if (forceNotify && newTradesCount === 0) {
        await sendTelegram('✅ Aucun nouveau trade détecté');
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// DÉMARRAGE
// ============================================
init().then(() => {
    console.log('🤖 Bot prêt! Utilise /start_watch sur Telegram pour commencer.\n');
}).catch(error => {
    console.error('❌ Erreur initialisation:', error);
    process.exit(1);
});
