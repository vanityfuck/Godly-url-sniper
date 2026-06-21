const axios = require('axios');
const WebSocket = require('ws');
const http2 = require('http2');
const tls = require('tls');

// ============ CONFIG ============
const USER_TOKEN = '';
const TARGET_GUILD_ID = '';
const WEBHOOK_URL = '';
// ============ HTTP2 AGENT WITH KEEP-ALIVE ============
const http2Agent = new http2.Agent({
    keepAlive: true,
    keepAliveMsecs: 500,
    maxSockets: 50,
    maxFreeSockets: 20,
    timeout: 3000,
    scheduling: 'lifo'
});

// ============ TLS WARMUP ============
async function warmupConnections() {
    console.log('Warming up TLS connections...');
    const targets = ['discord.com:443', 'gateway.discord.gg:443'];
    
    await Promise.all(targets.map(target => {
        return new Promise((resolve) => {
            const socket = tls.connect({
                host: target.split(':')[0],
                port: 443,
                rejectUnauthorized: false,
                ALPNProtocols: ['h2']
            }, () => {
                socket.destroy();
                resolve();
            });
            socket.on('error', () => resolve());
            setTimeout(() => { socket.destroy(); resolve(); }, 2000);
        });
    }));
    console.log('TLS warmup complete');
}

// ============ GET CURRENT VANITY ============
async function getCurrentVanity() {
    try {
        const response = await axios.get(
            `https://discord.com/api/v10/guilds/${TARGET_GUILD_ID}/vanity-url`,
            {
                headers: {
                    'Authorization': USER_TOKEN,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                },
                httpsAgent: http2Agent,
                timeout: 3000
            }
        );
        return response.data.code || null;
    } catch (error) {
        if (error.response?.status === 401) {
            console.log('Token expired - please update token');
            process.exit(1);
        }
        return null;
    }
}

// ============ CLAIM VANITY (HTTP2) ============
async function claimVanity(vanity) {
    return new Promise((resolve) => {
        const client = http2.connect('https://discord.com:443', {
            settings: {
                enablePush: false,
                initialWindowSize: 6291456
            }
        });
        
        const headers = {
            ':method': 'PATCH',
            ':path': `/api/v10/guilds/${TARGET_GUILD_ID}/vanity-url`,
            ':scheme': 'https',
            ':authority': 'discord.com',
            'authorization': USER_TOKEN,
            'content-type': 'application/json',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'accept': '*/*',
            'accept-encoding': 'gzip, deflate, br',
            'accept-language': 'en-US,en;q=0.9',
            'origin': 'https://discord.com',
            'referer': 'https://discord.com/channels/@me'
        };
        
        const req = client.request(headers);
        req.write(JSON.stringify({ code: vanity }));
        req.end();
        
        req.on('response', (responseHeaders) => {
            let data = '';
            req.on('data', (chunk) => { data += chunk; });
            req.on('end', () => {
                client.close();
                try {
                    const status = responseHeaders[':status'];
                    if (status === 200) {
                        const json = JSON.parse(data);
                        if (json.code === vanity) {
                            console.log('CLAIMED: ' + vanity + ' on guild ' + TARGET_GUILD_ID);
                            notifyWebhook('Claimed ' + vanity + ' on guild ' + TARGET_GUILD_ID);
                            process.exit(0);
                        }
                    } else if (status === 429) {
                        const wait = parseInt(responseHeaders['retry-after'] || 1);
                        console.log('Rate limited, waiting ' + wait + 's');
                        setTimeout(() => resolve(false), wait * 1000);
                    } else if (status === 400) {
                        console.log('Already taken or invalid');
                        resolve(false);
                    } else if (status === 403) {
                        console.log('Forbidden - missing permissions');
                        resolve(false);
                    } else if (status === 401) {
                        console.log('Invalid token');
                        process.exit(1);
                    }
                } catch (e) {
                    resolve(false);
                }
                resolve(false);
            });
        });
        
        req.on('error', () => {
            client.close();
            resolve(false);
        });
        
        setTimeout(() => {
            client.close();
            resolve(false);
        }, 2000);
    });
}

// ============ WEBSOCKET GATEWAY ============
function gatewayListener() {
    const ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
    
    ws.on('open', function() {
        ws.send(JSON.stringify({
            op: 2,
            d: {
                token: USER_TOKEN,
                intents: 1 << 1,
                properties: {
                    os: 'linux',
                    browser: 'chrome',
                    device: 'chrome'
                }
            }
        }));
        console.log('Gateway connected');
    });
    
    ws.on('message', function(data) {
        try {
            const packet = JSON.parse(data);
            if (packet.t === 'GUILD_UPDATE' && packet.d?.id === TARGET_GUILD_ID) {
                console.log('Vanity status changed on target guild');
                attackMode();
            }
        } catch (e) {}
    });
    
    ws.on('error', function() {
        console.log('Gateway error - reconnecting');
        setTimeout(gatewayListener, 1000);
    });
    
    ws.on('close', function() {
        console.log('Gateway closed - reconnecting');
        setTimeout(gatewayListener, 1000);
    });
}

// ============ ATTACK MODE (5 PARALLEL) ============
let attacking = false;
let currentVanity = null;

async function attackMode() {
    if (attacking) return;
    attacking = true;
    
    currentVanity = await getCurrentVanity();
    if (!currentVanity) {
        console.log('No vanity URL found on target guild');
        attacking = false;
        return;
    }
    
    console.log('Target vanity: ' + currentVanity);
    console.log('Attack started with 5 parallel requests');
    
    const promises = [];
    for (let i = 0; i < 5; i++) {
        promises.push(claimVanity(currentVanity));
    }
    await Promise.all(promises);
    
    attacking = false;
}

// ============ WEBHOOK NOTIFICATION ============
async function notifyWebhook(message) {
    try {
        if (WEBHOOK_URL) {
            await axios.post(WEBHOOK_URL, { content: message });
        }
    } catch (e) {}
}

// ============ MAIN ============
console.log('Target Guild ID: ' + TARGET_GUILD_ID);
console.log('HTTP2 mode: ON');
console.log('Keep-Alive: ON');
console.log('TLS Warmup: ON');
console.log('Attack mode: 5 concurrent requests');

(async function() {
    await warmupConnections();
    
    const vanity = await getCurrentVanity();
    if (vanity) {
        console.log('Current vanity: ' + vanity);
        attackMode();
    } else {
        console.log('No vanity URL found - monitoring for changes');
    }
})();

gatewayListener();

setInterval(function() {
    if (!attacking) {
        attackMode();
    }
}, 100);
