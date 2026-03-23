const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Global variables
let sock;
let qrCodeData = null;
let isConnected = false;

// Logger
const logger = pino({ level: 'silent' });

// Initialize WhatsApp Connection
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger,
        browser: ['WhatsApp Gateway', 'Chrome', '1.0.0']
    });

    // Connection updates
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrCodeData = qr;
            console.log('📱 QR Code දිස්වෙනවා terminal එකේ. Scan කරන්න!');
            qrcode.generate(qr, { small: true });
        }
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('🔌 Connection එක close වුණා:', lastDisconnect?.error, ', Reconnecting:', shouldReconnect);
            
            isConnected = false;
            
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp Connected!');
            isConnected = true;
            qrCodeData = null;
        }
    });

    // Save credentials when updated
    sock.ev.on('creds.update', saveCreds);
    
    // Message events (optional - for receiving messages)
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify') {
            const message = messages[0];
            if (!message.key.fromMe) {
                console.log('📨 New message:', message.message?.conversation || message.message?.extendedTextMessage?.text);
            }
        }
    });
}

// API Routes

// Health check
app.get('/', (req, res) => {
    res.json({
        status: 'running',
        connected: isConnected,
        message: 'WhatsApp Gateway API'
    });
});

// Get connection status
app.get('/status', (req, res) => {
    res.json({
        connected: isConnected,
        qrCode: qrCodeData,
        message: isConnected ? 'Connected to WhatsApp' : 'Not connected'
    });
});

// Get QR Code
app.get('/qr', (req, res) => {
    if (qrCodeData) {
        res.json({
            qrCode: qrCodeData,
            message: 'Scan this QR code with WhatsApp'
        });
    } else if (isConnected) {
        res.json({
            message: 'Already connected. No QR code needed.'
        });
    } else {
        res.status(404).json({
            error: 'QR code not available yet. Try again in a moment.'
        });
    }
});

// Send message
app.post('/send-message', async (req, res) => {
    try {
        const { number, message } = req.body;
        
        if (!number || !message) {
            return res.status(400).json({
                error: 'Number and message are required',
                example: {
                    number: '94771234567',
                    message: 'Hello from Gateway!'
                }
            });
        }
        
        if (!isConnected) {
            return res.status(503).json({
                error: 'WhatsApp not connected. Please scan QR code first.'
            });
        }
        
        // Format number (remove + and add @s.whatsapp.net)
        const formattedNumber = number.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        
        // Send message
        await sock.sendMessage(formattedNumber, { text: message });
        
        res.json({
            success: true,
            message: 'Message sent successfully',
            to: number
        });
        
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({
            error: 'Failed to send message',
            details: error.message
        });
    }
});

// Send message with typing simulation
app.post('/send-message-typing', async (req, res) => {
    try {
        const { number, message, delay = 2000 } = req.body;
        
        if (!number || !message) {
            return res.status(400).json({
                error: 'Number and message are required'
            });
        }
        
        if (!isConnected) {
            return res.status(503).json({
                error: 'WhatsApp not connected'
            });
        }
        
        const formattedNumber = number.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        
        // Send typing indicator
        await sock.sendPresenceUpdate('composing', formattedNumber);
        
        // Wait
        await new Promise(resolve => setTimeout(resolve, delay));
        
        // Send message
        await sock.sendMessage(formattedNumber, { text: message });
        
        // Stop typing
        await sock.sendPresenceUpdate('paused', formattedNumber);
        
        res.json({
            success: true,
            message: 'Message sent with typing simulation',
            to: number
        });
        
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({
            error: 'Failed to send message',
            details: error.message
        });
    }
});

// Logout
app.post('/logout', async (req, res) => {
    try {
        if (sock) {
            await sock.logout();
            isConnected = false;
            qrCodeData = null;
            res.json({
                success: true,
                message: 'Logged out successfully'
            });
        } else {
            res.status(400).json({
                error: 'No active connection to logout'
            });
        }
    } catch (error) {
        res.status(500).json({
            error: 'Failed to logout',
            details: error.message
        });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 WhatsApp Gateway running on http://localhost:${PORT}`);
    console.log(`📡 Status endpoint: http://localhost:${PORT}/status`);
    console.log(`📨 Send message endpoint: http://localhost:${PORT}/send-message`);
    console.log('\n⚡ Starting WhatsApp connection...\n');
    
    // Connect to WhatsApp
    connectToWhatsApp();
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n👋 Shutting down...');
    if (sock) {
        await sock.end();
    }
    process.exit(0);
});
