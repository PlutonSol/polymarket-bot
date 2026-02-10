require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    TARGET_WALLET: '0x594edb9112f526fa6a80b8f858a6379c8a2c1c11',
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '8525426243:AAHfQdqz1jUD4algSX15z2SHvsziOG0rxxs',
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '410866851',
    CHECK_INTERVAL: 20000,
};

let telegramBot;
let isRunning = false;
let knownTrades = new Set();

// ============================================
// INIT
// ============================================
async function init() {
    console.log('🚀 Bot Polymarket v4\n');
    
    telegramBot = new TelegramBot(CONFIG.TELEGRAM_BOT_TOKEN, { polling: true });
    setupTelegramCommands();
    
    await sendTelegram(`🤖 *Bot v4 démarré*

/start\\_watch - Démarrer
/stop\\_watch - Arrêter
/recent - Voir derniers trades`);
    
    return true;
}

// ============================================
// TELEGRAM
// ============================================
function setupTelegramCommands() {
    telegramBot.onText(/\/start_watch/, async (msg) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;
        if (isRunning) return await sendTelegram('⚠️ Déjà actif');
        isRunning = true;
        await sendTelegram('🟢 *Surveillance activée!*');
        startWatching();
    });
    
    telegramBot.onText(/\/stop_watch/, async (msg) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;
        isRunning = false;
        await sendTelegram('🔴 *Arrêté*');
    });
    
    telegramBot.onText(/\/recent/, async (msg) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;
        await showRecentTrades();
    });
    
    telegramBot.onText(/\/status/, async (msg) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;
        await sendTelegram(`📊 ${isRunning ? '🟢 Actif' : '🔴 Arrêté'} | Trades: ${knownTrades.size}`);
    });
}

async function sendTelegram(message) {
    try {
        await telegramBot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message, { 
            parse_mode: 'Markdown',
            disable_web_page_preview: true 
        });
    } catch (error) {
        console.error('Telegram error:', error.message);
    }
}

// ============================================
// API
// ============================================
async function fetchActivity() {
    try {
        const res = await fetch(
            `https://data-api.polymarket.com/activity?user=${CONFIG.TARGET_WALLET.toLowerCase()}&limit=30`
        );
        if (res.ok) {
            return await res.json();
        }
    } catch (e) {
        console.error('API error:', e.message);
    }
    return [];
}

// ============================================
// WATCH
// ============================================
async function startWatching() {
    console.log('🔄 Démarrage...\n');
    
    // Charger trades existants pour ne pas spam
    const initial = await fetchActivity();
    if (Array.isArray(initial)) {
        for (const t of initial) {
            knownTrades.add(getTradeId(t));
        }
    }
    console.log(`📊 ${knownTrades.size} trades chargés\n`);
    
    while (isRunning) {
        try {
            await checkNewTrades();
        } catch (e) {
            console.error('Error:', e.message);
        }
        await sleep(CONFIG.CHECK_INTERVAL);
    }
}

function getTradeId(t) {
    // Créer un ID unique basé sur plusieurs champs
    return `${t.id || ''}-${t.transactionHash || t.transaction_hash || ''}-${t.timestamp || t.createdAt || ''}-${t.conditionId || t.asset_id || ''}`;
}

async function checkNewTrades() {
    const trades = await fetchActivity();
    if (!Array.isArray(trades)) return;
    
    for (const t of trades) {
        const id = getTradeId(t);
        if (knownTrades.has(id)) continue;
        
        knownTrades.add(id);
        
        // Envoyer notification
        await notifyTrade(t);
    }
}

async function notifyTrade(t) {
    // Extraire les données
    const type = t.type || t.action || t.side || 'trade';
    const isBuy = type.toLowerCase().includes('buy');
    const emoji = isBuy ? '🟢 ACHAT' : '🔴 VENTE';
    
    // Marché
    let market = t.title || t.question || t.market || t.description || 'Marché inconnu';
    if (market.length > 100) market = market.slice(0, 100) + '...';
    
    // Valeurs
    const outcome = t.outcome || t.outcomeIndex || t.position || '';
    const price = parseFloat(t.price || t.avgPrice || t.avg_price || 0);
    const size = parseFloat(t.size || t.amount || t.shares || 0);
    const usdcSize = parseFloat(t.usdcSize || t.value || t.total || (price * size) || 0);
    
    // Timestamp
    let timeStr = 'N/A';
    const ts = t.timestamp || t.createdAt || t.created_at || t.time;
    if (ts) {
        try {
            const date = new Date(typeof ts === 'number' && ts < 10000000000 ? ts * 1000 : ts);
            if (date.getFullYear() > 2020) {
                timeStr = date.toLocaleString('fr-FR');
            }
        } catch (e) {}
    }
    
    const message = `🔔 *NOUVEAU TRADE!*

${emoji}

📊 *Marché:*
${market}

💰 *Détails:*
• Type: ${type}
• Position: ${outcome || 'N/A'}
• Prix: $${price.toFixed(4)}
• Quantité: ${size.toFixed(2)}
• Total: $${usdcSize.toFixed(2)}

⏰ ${timeStr}`;
    
    console.log(`📈 Trade: ${type} - $${usdcSize.toFixed(2)} - ${market.slice(0, 50)}`);
    await sendTelegram(message);
}

async function showRecentTrades() {
    await sendTelegram('🔍 Récupération...');
    
    const trades = await fetchActivity();
    if (!Array.isArray(trades) || trades.length === 0) {
        return await sendTelegram('❌ Aucun trade trouvé');
    }
    
    let msg = '📋 *5 derniers trades:*\n\n';
    
    for (const t of trades.slice(0, 5)) {
        const type = t.type || t.action || t.side || 'trade';
        const market = (t.title || t.question || t.market || 'Inconnu').slice(0, 40);
        const usdcSize = parseFloat(t.usdcSize || t.value || t.total || 0);
        
        let timeStr = '';
        const ts = t.timestamp || t.createdAt || t.created_at;
        if (ts) {
            try {
                const date = new Date(typeof ts === 'number' && ts < 10000000000 ? ts * 1000 : ts);
                if (date.getFullYear() > 2020) {
                    timeStr = date.toLocaleString('fr-FR');
                }
            } catch (e) {}
        }
        
        msg += `• *${type.toUpperCase()}* - $${usdcSize.toFixed(2)}\n`;
        msg += `  ${market}...\n`;
        msg += `  ${timeStr}\n\n`;
    }
    
    await sendTelegram(msg);
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ============================================
// START
// ============================================
init().catch(e => {
    console.error('❌', e);
    process.exit(1);
});
