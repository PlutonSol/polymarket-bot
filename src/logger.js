const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const LOG_FILE = path.join(LOG_DIR, `bot-${new Date().toISOString().slice(0, 10)}.log`);

function formatTime() {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function writeLog(level, ...args) {
    const msg = `[${formatTime()}] [${level}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}`;
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
