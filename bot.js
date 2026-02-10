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
    CHECK_INTERVAL: 30000, // 30 secondes
};

// ============================================
// VARIABLES GLOBALES
// ============================================
let telegramBot;
let isRunning = false;
let knownTrades = new Set();
let marketsCache = new Map();

// ============================================
// INITIALISATION
// ============================================
async function init() {
    console.log('🚀 Initialisation du bot de notifications Polymarket...\n');
    
    telegramBot = new TelegramBot(CONFIG.TELEGRAM_BOT_TOKEN, { polling: true });
    setupTelegramCommands();
    
    console.log('✅ Bot initialisé avec succès!\n');
    console.log('📊 Configuration:');
    console.log(`   Wallet surveillé: ${CONFIG.TARGET_WALLET}`);
    console.log(`   Intervalle: ${CONFIG.CHECK_INTERVAL / 1000}s`);
    console.log('');
    
    await sendTelegram(`🤖 *Bot Polymarket Notifications v2*

📊 Wallet surveillé: \`${shortenAddress(CONFIG.TARGET_WALLET)}\`

Commandes:
/start\\_watch - Démarrer
/stop\\_watch - Arrêter
/status - Statut
/recent - Derniers trades`);
    
    return true;
}

// ============================================
// FONCTIONS TELEGRAM
// ============================================
function setupTelegramCommands() {
    telegramBot.onText(/\/start_watch/, async (msg) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;
        
        if (isRunning) {
            await sendTelegram('⚠️ Déjà actif');
            return;
        }
        
        isRunning = true;
        await sendTelegram('🟢 *Surveillance activée!*');
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
        await sendTelegram(`📊 *Statut:* ${status}\nTrades connus: ${knownTrades.size}`);
    });
    
    telegramBot.onText(/\/recent/, async (msg) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;
        await sendTelegram('🔍 Récupération des derniers trades...');
        await showRecentTrades();
    });
}

async function sendTelegram(message) {
    try {
        await telegramBot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message, { 
            parse_mode: 'Markdown',
            disable_web_page_preview: true 
        });
    } catch (error) {
        console.error('Erreur Telegram:', error.message);
    }
}

function shortenAddress(address) {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// ============================================
// API POLYMARKET
// ============================================
async function fetchActivityFeed() {
    try {
        // Utiliser l'API d'activité de Polymarket
        const response = await fetch(
            `https://polymarket.com/api/profile/${CONFIG.TARGET_WALLET}/activity?limit=20`,
            {
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'Mozilla/5.0'
                }
            }
        );
        
        if (response.ok) {
            const data = await response.json();
            return data;
        }
    } catch (error) {
        console.error('Erreur API activity:', error.message);
    }
    
    // Fallback: API CLOB
    try {
        const response = await fetch(
            `https://clob.polymarket.com/activity?user=${CONFIG.TARGET_WALLET.toLowerCase()}&limit=20`
        );
        
        if (response.ok) {
            return await response.json();
        }
    } catch (error) {
        console.error('Erreur API CLOB:', error.message);
    }
    
    // Fallback 2: Gamma API trades
    try {
        const response = await fetch(
            `https://gamma-api.polymarket.com/activity?address=${CONFIG.TARGET_WALLET.toLowerCase()}&limit=20`
        );
        
        if (response.ok) {
            return await response.json();
        }
    } catch (error) {
        console.error('Erreur Gamma API:', error.message);
    }
    
    return null;
}

async function fetchTradesFromGamma() {
    try {
        const response = await fetch(
            `https://gamma-api.polymarket.com/trades?maker_address=${CONFIG.TARGET_WALLET.toLowerCase()}&limit=20`
        );
        
        if (response.ok) {
            return await response.json();
        }
    } catch (error) {
        console.error('Erreur Gamma trades:', error.message);
    }
    return null;
}

async function fetchMarketByCondition(conditionId) {
    if (marketsCache.has(conditionId)) {
        return marketsCache.get(conditionId);
    }
    
    try {
        const response = await fetch(
            `https://gamma-api.polymarket.com/markets?condition_id=${conditionId}`
        );
        
        if (response.ok) {
            const data = await response.json();
            if (data && data.length > 0) {
                marketsCache.set(conditionId, data[0]);
                return data[0];
            }
        }
    } catch (error) {
        console.error('Erreur fetch market:', error.message);
    }
    return null;
}

async function fetchMarketBySlug(slug) {
    if (marketsCache.has(slug)) {
        return marketsCache.get(slug);
    }
    
    try {
        const response = await fetch(
            `https://gamma-api.polymarket.com/markets?slug=${slug}`
        );
        
        if (response.ok) {
            const data = await response.json();
            if (data && data.length > 0) {
                marketsCache.set(slug, data[0]);
                return data[0];
            }
        }
    } catch (error) {
        console.error('Erreur fetch market by slug:', error.message);
    }
    return null;
}

// ============================================
// SURVEILLANCE
// ============================================
async function startWatching() {
    console.log('🔄 Démarrage de la surveillance...\n');
    
    // Charger les trades existants
    const initialData = await fetchActivityFeed();
    if (initialData && Array.isArray(initialData)) {
        for (const item of initialData) {
            const tradeId = item.id || item.transaction_hash || `${item.timestamp}-${item.market}`;
            knownTrades.add(tradeId);
        }
    }
    
    const gammaData = await fetchTradesFromGamma();
    if (gammaData && Array.isArray(gammaData)) {
        for (const item of gammaData) {
            const tradeId = item.id || item.transaction_hash || `${item.timestamp}-${item.asset_id}`;
            knownTrades.add(tradeId);
        }
    }
    
    console.log(`📊 ${knownTrades.size} trades existants chargés`);
    
    while (isRunning) {
        try {
            await checkNewTrades();
        } catch (error) {
            console.error('Erreur boucle:', error.message);
        }
        await sleep(CONFIG.CHECK_INTERVAL);
    }
}

async function checkNewTrades() {
    // Vérifier l'API d'activité
    const activity = await fetchActivityFeed();
    if (activity && Array.isArray(activity)) {
        await processNewItems(activity, 'activity');
    }
    
    // Vérifier aussi Gamma API
    const gammaTrades = await fetchTradesFromGamma();
    if (gammaTrades && Array.isArray(gammaTrades)) {
        await processNewItems(gammaTrades, 'gamma');
    }
}

async function processNewItems(items, source) {
    for (const item of items) {
        const tradeId = item.id || item.transaction_hash || `${item.timestamp}-${item.market || item.asset_id}`;
        
        if (knownTrades.has(tradeId)) continue;
        
        // Vérifier que le timestamp est récent (moins de 24h)
        const timestamp = parseTimestamp(item.timestamp || item.created_at || item.time);
        if (!timestamp || Date.now() - timestamp > 24 * 60 * 60 * 1000) {
            knownTrades.add(tradeId);
            continue;
        }
        
        knownTrades.add(tradeId);
        
        // Récupérer les infos du marché
        let marketName = item.market || item.question || item.title || 'Marché inconnu';
        
        if (item.condition_id) {
            const market = await fetchMarketByCondition(item.condition_id);
            if (market) {
                marketName = market.question || market.title || marketName;
            }
        } else if (item.slug) {
            const market = await fetchMarketBySlug(item.slug);
            if (market) {
                marketName = market.question || market.title || marketName;
            }
        }
        
        // Déterminer le type de trade
        const action = item.action || item.side || item.type || 'TRADE';
        const isBuy = action.toLowerCase().includes('buy') || action.toLowerCase().includes('achat');
        const emoji = isBuy ? '🟢 ACHAT' : '🔴 VENTE';
        
        // Extraire les valeurs
        const outcome = item.outcome || item.position || (item.outcome_index === 0 ? 'Yes' : 'No') || 'N/A';
        const price = parseFloat(item.price || item.avg_price || 0);
        const size = parseFloat(item.size || item.amount || item.shares || 0);
        const total = item.total || item.value || (price * size) || 0;
        
        const timeStr = new Date(timestamp).toLocaleString('fr-FR', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
        
        // Envoyer notification
        await sendTelegram(`🔔 *Nouveau Trade!*

${emoji}

📊 *Marché:*
${marketName}

💰 *Détails:*
• Position: ${outcome}
• Prix: $${price.toFixed(2)}
• Quantité: ${size.toFixed(2)}
• Total: $${parseFloat(total).toFixed(2)}

⏰ ${timeStr}`);
        
        console.log(`📈 Nouveau trade [${source}]: ${emoji} - ${marketName}`);
    }
}

function parseTimestamp(ts) {
    if (!ts) return null;
    
    // Si c'est déjà un nombre (Unix timestamp)
    if (typeof ts === 'number') {
        // Si c'est en secondes, convertir en ms
        if (ts < 10000000000) {
            ts = ts * 1000;
        }
        // Vérifier que c'est une date valide (après 2020)
        if (ts < 1577836800000) return null; // Avant 2020
        return ts;
    }
    
    // Si c'est une string
    const parsed = Date.parse(ts);
    if (isNaN(parsed) || parsed < 1577836800000) return null;
    return parsed;
}

async function showRecentTrades() {
    const activity = await fetchActivityFeed();
    const gamma = await fetchTradesFromGamma();
    
    let message = '📋 *Derniers trades:*\n\n';
    let count = 0;
    
    const allTrades = [...(activity || []), ...(gamma || [])];
    
    // Trier par timestamp
    allTrades.sort((a, b) => {
        const tsA = parseTimestamp(a.timestamp || a.created_at) || 0;
        const tsB = parseTimestamp(b.timestamp || b.created_at) || 0;
        return tsB - tsA;
    });
    
    for (const item of allTrades.slice(0, 5)) {
        const ts = parseTimestamp(item.timestamp || item.created_at);
        if (!ts) continue;
        
        const marketName = item.market || item.question || item.title || 'Inconnu';
        const action = item.action || item.side || 'TRADE';
        const total = item.total || item.value || (parseFloat(item.price || 0) * parseFloat(item.size || 0));
        const timeStr = new Date(ts).toLocaleString('fr-FR');
        
        message += `• ${action.toUpperCase()} - $${parseFloat(total).toFixed(2)}\n`;
        message += `  ${marketName.slice(0, 50)}...\n`;
        message += `  ${timeStr}\n\n`;
        count++;
    }
    
    if (count === 0) {
        message += 'Aucun trade récent trouvé';
    }
    
    await sendTelegram(message);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// DÉMARRAGE
// ============================================
init().then(() => {
    console.log('🤖 Bot prêt! /start_watch sur Telegram\n');
}).catch(error => {
    console.error('❌ Erreur:', error);
    process.exit(1);
});
