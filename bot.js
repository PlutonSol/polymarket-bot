require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    TARGET_WALLET: '0x594edb9112f526fa6a80b8f858a6379c8a2c1c11',
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '8525426243:AAHfQdqz1jUD4algSX15z2SHvsziOG0rxxs',
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '410866851',
    CHECK_INTERVAL: 20000, // 20 secondes
};

let telegramBot;
let isRunning = false;
let knownTrades = new Set();

// ============================================
// INITIALISATION
// ============================================
async function init() {
    console.log('🚀 Bot Polymarket v3...\n');
    
    telegramBot = new TelegramBot(CONFIG.TELEGRAM_BOT_TOKEN, { polling: true });
    setupTelegramCommands();
    
    console.log('✅ Bot prêt!');
    console.log(`📊 Wallet: ${CONFIG.TARGET_WALLET}\n`);
    
    await sendTelegram(`🤖 *Bot Polymarket v3 démarré*

📊 Wallet: \`${CONFIG.TARGET_WALLET.slice(0,10)}...\`

/start\\_watch - Démarrer
/stop\\_watch - Arrêter  
/test - Tester l'API`);
    
    return true;
}

// ============================================
// TELEGRAM
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
        await sendTelegram('🔴 *Arrêté*');
    });
    
    telegramBot.onText(/\/test/, async (msg) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;
        await testAPIs();
    });
    
    telegramBot.onText(/\/status/, async (msg) => {
        if (msg.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;
        await sendTelegram(`📊 Status: ${isRunning ? '🟢 Actif' : '🔴 Arrêté'}\nTrades connus: ${knownTrades.size}`);
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

// ============================================
// APIs POLYMARKET
// ============================================
async function testAPIs() {
    await sendTelegram('🔍 Test des APIs...');
    
    // Test 1: Data API - Activity
    try {
        const url1 = `https://data-api.polymarket.com/activity?user=${CONFIG.TARGET_WALLET.toLowerCase()}&limit=5`;
        console.log('Test:', url1);
        const res1 = await fetch(url1);
        const data1 = await res1.json();
        console.log('Data API activity:', JSON.stringify(data1).slice(0, 200));
        await sendTelegram(`✅ Data API activity: ${res1.status} - ${Array.isArray(data1) ? data1.length : 0} résultats`);
    } catch (e) {
        await sendTelegram(`❌ Data API activity: ${e.message}`);
    }
    
    // Test 2: Data API - Trades
    try {
        const url2 = `https://data-api.polymarket.com/trades?user=${CONFIG.TARGET_WALLET.toLowerCase()}&limit=5`;
        console.log('Test:', url2);
        const res2 = await fetch(url2);
        const data2 = await res2.json();
        console.log('Data API trades:', JSON.stringify(data2).slice(0, 200));
        await sendTelegram(`✅ Data API trades: ${res2.status} - ${Array.isArray(data2) ? data2.length : 0} résultats`);
    } catch (e) {
        await sendTelegram(`❌ Data API trades: ${e.message}`);
    }
    
    // Test 3: Profil Polymarket
    try {
        const url3 = `https://polymarket.com/api/profile/${CONFIG.TARGET_WALLET.toLowerCase()}`;
        console.log('Test:', url3);
        const res3 = await fetch(url3, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const data3 = await res3.json();
        console.log('Profile API:', JSON.stringify(data3).slice(0, 200));
        await sendTelegram(`✅ Profile API: ${res3.status}`);
    } catch (e) {
        await sendTelegram(`❌ Profile API: ${e.message}`);
    }
    
    // Test 4: Gamma API
    try {
        const url4 = `https://gamma-api.polymarket.com/trades?maker_address=${CONFIG.TARGET_WALLET.toLowerCase()}&limit=5`;
        console.log('Test:', url4);
        const res4 = await fetch(url4);
        const data4 = await res4.json();
        console.log('Gamma API:', JSON.stringify(data4).slice(0, 200));
        await sendTelegram(`✅ Gamma API: ${res4.status} - ${Array.isArray(data4) ? data4.length : 0} résultats`);
    } catch (e) {
        await sendTelegram(`❌ Gamma API: ${e.message}`);
    }
}

async function fetchTrades() {
    const allTrades = [];
    
    // Source 1: Data API activity
    try {
        const res = await fetch(
            `https://data-api.polymarket.com/activity?user=${CONFIG.TARGET_WALLET.toLowerCase()}&limit=30&type=trade`
        );
        if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data)) {
                allTrades.push(...data.map(t => ({ ...t, source: 'data-activity' })));
            }
        }
    } catch (e) {
        console.error('data-api activity error:', e.message);
    }
    
    // Source 2: Data API trades
    try {
        const res = await fetch(
            `https://data-api.polymarket.com/trades?user=${CONFIG.TARGET_WALLET.toLowerCase()}&limit=30`
        );
        if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data)) {
                allTrades.push(...data.map(t => ({ ...t, source: 'data-trades' })));
            }
        }
    } catch (e) {
        console.error('data-api trades error:', e.message);
    }
    
    // Source 3: Gamma API
    try {
        const res = await fetch(
            `https://gamma-api.polymarket.com/trades?maker_address=${CONFIG.TARGET_WALLET.toLowerCase()}&limit=30`
        );
        if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data)) {
                allTrades.push(...data.map(t => ({ ...t, source: 'gamma' })));
            }
        }
    } catch (e) {
        console.error('gamma error:', e.message);
    }
    
    return allTrades;
}

// ============================================
// SURVEILLANCE
// ============================================
async function startWatching() {
    console.log('🔄 Surveillance démarrée...\n');
    
    // Charger trades existants
    const initial = await fetchTrades();
    for (const t of initial) {
        const id = getTradeId(t);
        knownTrades.add(id);
    }
    console.log(`📊 ${knownTrades.size} trades existants\n`);
    
    while (isRunning) {
        try {
            await checkNewTrades();
        } catch (e) {
            console.error('Erreur:', e.message);
        }
        await sleep(CONFIG.CHECK_INTERVAL);
    }
}

function getTradeId(trade) {
    return trade.id || 
           trade.transactionHash || 
           trade.transaction_hash ||
           `${trade.timestamp || trade.created_at}-${trade.asset_id || trade.market || trade.conditionId}`;
}

function parseTime(t) {
    if (!t) return 0;
    if (typeof t === 'number') {
        return t < 10000000000 ? t * 1000 : t;
    }
    return Date.parse(t) || 0;
}

async function checkNewTrades() {
    const trades = await fetchTrades();
    
    for (const trade of trades) {
        const id = getTradeId(trade);
        
        if (knownTrades.has(id)) continue;
        
        // Vérifier timestamp récent (< 1 heure)
        const ts = parseTime(trade.timestamp || trade.created_at || trade.time);
        if (ts < Date.now() - 3600000) {
            knownTrades.add(id);
            continue;
        }
        
        knownTrades.add(id);
        
        // Construire le message
        const side = trade.side || trade.type || trade.action || 'TRADE';
        const isBuy = side.toLowerCase().includes('buy');
        const emoji = isBuy ? '🟢 ACHAT' : '🔴 VENTE';
        
        const market = trade.market || trade.question || trade.title || trade.conditionId || 'Inconnu';
        const outcome = trade.outcome || trade.position || 'N/A';
        const price = parseFloat(trade.price || trade.avg_price || 0);
        const size = parseFloat(trade.size || trade.amount || trade.shares || 0);
        const total = parseFloat(trade.total || trade.value || trade.usdcSize || (price * size) || 0);
        
        const timeStr = new Date(ts).toLocaleString('fr-FR');
        
        console.log(`📈 Nouveau trade: ${side} - ${market.slice(0, 50)}`);
        
        await sendTelegram(`🔔 *NOUVEAU TRADE!*

${emoji}

📊 *Marché:*
${market.slice(0, 100)}

💰 *Détails:*
• Position: ${outcome}
• Prix: $${price.toFixed(2)}
• Quantité: ${size.toFixed(2)}
• Total: $${total.toFixed(2)}

⏰ ${timeStr}
📡 Source: ${trade.source}`);
    }
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
