const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const LOG_FILE = path.join(LOG_DIR, `bot-${new Date().toISOString().slice(0, 10)}.log`);

function formatTime() {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// Patterns de secrets à masquer dans les logs
const SECRET_PATTERNS = [
    /0x[a-fA-F0-9]{64}/g,                    // Private keys
    /sk-[a-zA-Z0-9]{20,}/g,                  // OpenAI API keys
    /sk-ant-[a-zA-Z0-9-]{20,}/g,             // Anthropic API keys
    /\b\d{8,}:[A-Za-z0-9_-]{30,}\b/g,        // Telegram bot tokens
    /"key"\s*:\s*"[^"]+"/g,                   // API key in JSON objects
    /"secret"\s*:\s*"[^"]+"/g,                // API secret in JSON objects
    /"passphrase"\s*:\s*"[^"]+"/g,            // API passphrase in JSON objects
];

function sanitize(str) {
    if (typeof str !== 'string') return str;
    let result = str;
    for (const pattern of SECRET_PATTERNS) {
        result = result.replace(pattern, '***REDACTED***');
    }
    return result;
}

function writeLog(level, ...args) {
    const raw = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    const safe = sanitize(raw);
    const msg = `[${formatTime()}] [${level}] ${safe}`;
    console.log(msg);
    try {
        fs.appendFileSync(LOG_FILE, msg + '\n');
    } catch (_) {}
}

module.exports = {
    info: (...args) => writeLog('INFO', ...args),
    warn: (...args) => writeLog('WARN', ...args),
    error: (...args) => writeLog('ERROR', ...args),
    trade: (...args) => writeLog('TRADE', ...args),
    llm: (...args) => writeLog('LLM', ...args),
};
