const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const { body, validationResult } = require('express-validator');
const qrcode = require('qrcode');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

const port = process.env.PORT || 8897;
const app = express();
const server = http.createServer(app);
const io = socketIO(server, { allowEIO3: true });
const { phoneNumberFormatter } = require('./helpers/formatter');
const CLIENT_IDS = process.env.CLIENT_IDS ? process.env.CLIENT_IDS.split(',') : [];
const CLIENT_CONFIG = {};
CLIENT_IDS.forEach(id => {
    CLIENT_CONFIG[id] = {
        password: process.env[`${id}_PASSWORD`],
        apiKey: process.env[`${id}_API_KEY`]
    };
});
// --- PERUBAHAN: Objek untuk menyimpan status terakhir setiap klien ---
const clientStates = {};
const clientInits = {};
const clients = {}; // Objek untuk menyimpan semua instance klien

// --- Middleware & Setup ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

const initializeWhatsApp = async (clientId) => {
    // 1. Cek apakah sudah ada instance yang sedang berjalan atau aktif
    if (clients[clientId] || clientInits[clientId]) {
        console.log(`[${clientId}] Inisialisasi sudah berjalan atau client aktif.`);
        return;
    }
    clientInits[clientId] = true; // Tandai sedang proses inisialisasi
    console.log(`Menginisialisasi WhatsApp untuk ${clientId}...`);
    // clientStates[clientId] = { status: 'loading', data: null };
    io.to(clientId).emit('loading_screen'); // Kirim status loading ke frontend
    
    const client = new Client({
        restartOnAuthFail: false,
        puppeteer: { 
            headless: true, 
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage', 
                '--disable-gpu',
                '--no-zygote',
                '--single-process' // Membantu menghemat RAM pada multi-akun
            ]
        },
        authStrategy: new LocalAuth({ 
            clientId: clientId, 
            dataPath: './sessions' 
        }),
        webVersionCache: {
            type: 'remote',
            remotePath: `https://raw.githubusercontent.com/wppconnect-team/wa-version/refs/heads/main/html/2.3000.1031490220-alpha.html`,    
        },
    });
    
    clients[clientId] = client;
    
    client.on('qr', async (qr) => {
        clientInits[clientId] = false;
        console.log(`[${clientId}] QR Code diterima.`);
        const qrImage = await qrcode.toDataURL(qr);
        clientStates[clientId] = { status: 'qr', data: qrImage };
        io.to(clientId).emit('qr', qrImage);
        io.to(clientId).emit('message', 'Silakan pindai QR Code.');
    });
    
    client.on('ready', () => {
        console.log(`[${clientId}] SIAP!`);
        clientInits[clientId] = false;
        clientStates[clientId] = { status: 'ready', data: null };
        io.to(clientId).emit('ready');
        io.to(clientId).emit('message', `[${clientId}] Terhubung.`);
    });
    
    client.on('authenticated', () => {
        clientStates[clientId] = { status: 'authenticated', data: null };
        io.to(clientId).emit('authenticated');
    });
    
    client.on('auth_failure', () => {
        clientStates[clientId] = { status: 'auth_failure', data: null };
        io.to(clientId).emit('message', `[${clientId}] Autentikasi gagal.`);
    });
    
    client.on('disconnected', async (reason) => {
        console.log(`[${clientId}] Terputus: ${reason}`);
        io.to(clientId).emit('message', `[${clientId}] terputus, ${reason}.`);
        clientStates[clientId] = { status: 'disconnected', data: null };
        clientInits[clientId] = false;
        io.to(clientId).emit('message', `[${clientId}] Terputus. Halaman akan memuat ulang dalam 5 detik.`);
        
        try {
            await client.destroy(); // Pastikan proses chrome tertutup sempurna
        } catch (e) {}
        
        delete clients[clientId];
        if (reason === 'LOGOUT') {
            const fs = require('fs');
            const sessionPath = `./sessions/session-${clientId}`; // Sesuaikan dengan struktur LocalAuth
            if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
                console.log(`[${clientId}] Folder session dihapus karena logout.`);
            }
        }
        io.to(clientId).emit('message', 'WhatsApp Terputus.');
    });
    
    client.initialize().catch(err => {
        clientInits[clientId] = false;
        delete clients[clientId];
        console.error(`[${clientId}] Gagal:`, err);
    });
    
    // Simpan instance klien setelah dibuat
    clients[clientId] = client;
};

// Inisialisasi semua klien yang terdaftar di .env
// CLIENT_IDS.forEach(id => initializeWhatsApp(id));
// Logika Socket.IO diperbarui untuk memicu inisialisasi
io.on('connection', (socket) => {
    socket.on('join_room', (clientId) => {
        if (CLIENT_IDS.includes(clientId)) {
            socket.join(clientId);
            socket.emit('message', `Anda terhubung ke monitoring ${clientId}.`);
            
            if (!clients[clientId] && !clientInits[clientId]) {
                initializeWhatsApp(clientId);
            } else {
                const currentState = clientStates[clientId];
                if (currentState) {
                    // Kirim status terakhir agar UI sinkron tanpa refresh
                    if (currentState.status === 'qr') socket.emit('qr', currentState.data);
                    if (currentState.status === 'ready') socket.emit('ready');
                }
            }
        }
    });
});

// Middleware Keamanan
// --- Middleware Keamanan Terpadu ---
const isAuthorized = (req, res, next) => {
    const { clientId } = req.params;
    const apiKey = req.headers['x-api-key'];

    if (!CLIENT_CONFIG[clientId]) {
        return res.status(404).json({ status: false, message: 'Klien tidak ditemukan.' });
    }

    // 1. Cek Sesi (Prioritas untuk akses via Browser/client.html)
    if (req.session && req.session.isAuthenticated && req.session.clientId === clientId) {
        req.client = clients[clientId];
        return next();
    }

    // 2. Cek API Key (Untuk akses via API eksternal)
    if (req.path.startsWith('/api/')) {
        if (apiKey && apiKey === CLIENT_CONFIG[clientId].apiKey) {
            req.client = clients[clientId];
            return next();
        }
        return res.status(401).json({ status: false, message: 'Unauthorized: Sesi tidak valid atau API Key tidak ada.' });
    }

    return res.redirect('/');
};

// Fungsi untuk menangani error pengiriman
const handleSendError = (res, error, clientId) => {
    console.error(`[${clientId}] Error sending message:`, error.message);
    // PERBAIKAN: Periksa error spesifik dan anggap sukses jika cocok
    if (error.message.includes("Cannot read properties of undefined (reading 'serialize')")) {
        res.status(200).json({ status: true, message: "Pesan berhasil dikirim (dengan peringatan serialisasi)." });
    } else {
        // Untuk semua error lain, kirim respons error yang sebenarnya
        res.status(500).json({ status: false, message: error.message });
    }
}

// --- Routing & Endpoints ---
app.get('/', (req, res) => { res.render('login', { clientIds: CLIENT_IDS }); });
app.post('/login', (req, res) => {
    const { clientId, password } = req.body;
    if (CLIENT_CONFIG[clientId] && password === CLIENT_CONFIG[clientId].password) {
        req.session.isAuthenticated = true;
        req.session.clientId = clientId;
        res.json({ status: true, message: 'Login berhasil!' });
    } else { res.status(401).json({ status: false, message: 'Password salah.' }); }
});
app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});

app.get('/api/logout-wa/:clientId', isAuthorized, async (req, res) => {
    const { clientId } = req.params;
    try {
        if (clients[clientId]) {
            await clients[clientId].logout();
            await clients[clientId].destroy();
            delete clients[clientId];
            delete clientStates[clientId];
        }
        res.json({ status: true, message: 'WhatsApp Logout Berhasil.' });
    } catch (e) { res.status(500).json({ status: false, message: e.message }); }
});

app.get('/client/:clientId', isAuthorized, (req, res) => { res.sendFile(path.join(__dirname, 'views', 'client.html')); });

// --- Grup Endpoint API yang Diamankan ---

// Endpoint API untuk mengirim pesan
app.post('/api/send-message/:clientId', isAuthorized, [ body('number').notEmpty(), body('message').notEmpty() ], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(422).json({ status: false, errors: errors.array() });
    }
    try {
        const number = phoneNumberFormatter(req.body.number);
        await req.client.sendMessage(number, req.body.message);
        res.status(200).json({ status: true, message: "Pesan berhasil dikirim!" });
    } catch (error) {
        handleSendError(res, error, req.params.clientId);
    }
});

// Endpoint API untuk mengirim PDF
app.post('/api/send-pdf/:clientId', isAuthorized, [ body('number').notEmpty(), body('url').isURL(), body('filename').notEmpty() ], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(422).json({ status: false, errors: errors.array() });
    }
    try {
        const number = phoneNumberFormatter(req.body.number);
        const response = await axios.get(req.body.url, { responseType: 'arraybuffer' });
        const media = new MessageMedia('application/pdf', Buffer.from(response.data, 'binary').toString('base64'), req.body.filename);
        await req.client.sendMessage(number, media, { caption: req.body.caption || '' });
        res.status(200).json({ status: true, message: 'PDF berhasil dikirim!' });
    } catch (error) {
        console.error(`[${req.params.clientId}] ❌ Gagal kirim PDF:`, error.message);
        handleSendError(res, error, req.params.clientId);
    }
});

// Endpoint API untuk mengirim Excel
app.post('/api/send-excel/:clientId', isAuthorized, [ body('number').notEmpty(), body('url').isURL(), body('filename').notEmpty() ], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(422).json({ status: false, errors: errors.array() });
    }
    try {
        const number = phoneNumberFormatter(req.body.number);
        const response = await axios.get(req.body.url, { responseType: 'arraybuffer' });
        const ext = path.extname(req.body.filename).toLowerCase();
        if (ext !== '.xlsx') {
            return res.status(400).json({ status: false, message: 'File bukan format Excel (.xlsx)' });
        }
        const media = new MessageMedia('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', Buffer.from(response.data, 'binary').toString('base64'), req.body.filename);
        await req.client.sendMessage(number, media, { caption: req.body.caption || '' });
        res.status(200).json({ status: true, message: 'File Excel berhasil dikirim!' });
    } catch (error) {
        console.error(`[${req.params.clientId}] ❌ Gagal kirim Excel:`, error.message);
        // res.status(500).json({ status: false, message: 'Gagal mengirim file Excel', error: error.message });
        handleSendError(res, error, req.params.clientId);
    }
});

// Endpoint API untuk mengecek status koneksi
app.get('/api/check-status/:clientId', isAuthorized, async (req, res) => {
    try {
        const state = await req.client.getState();
        res.json({ status: true, message: `Status klien '${req.params.clientId}': ${state}`, data: { state: state } });
    } catch (error) {
        res.status(500).json({ status: false, message: 'Terjadi kesalahan saat memeriksa status.', error: error.message });
    }
});

// Endpoint untuk mendapatkan daftar seluruh chat
app.get('/api/chats/:clientId', isAuthorized, async (req, res) => {
    try {
        const chats = await req.client.getChats();
        const sortedChats = chats
        .filter(chat => chat.timestamp || (chat.lastMessage && chat.lastMessage.timestamp))
        .sort((a, b) => {
            const tA = a.timestamp || (a.lastMessage?.timestamp || 0);
            const tB = b.timestamp || (b.lastMessage?.timestamp || 0);
            return tB - tA; // terbaru ke atas
        })
        .slice(0, 25); // Ambil 50 teratas
        
        const chatList = await Promise.all(sortedChats.map(async (chat) => {
            const lastMsg = chat.lastMessage;
            let profilePic = null;
            
            try {
                profilePic = await req.client.getProfilePicUrl(chat.id._serialized);
            } catch (e) {
                profilePic = null; // Abaikan jika foto profil tidak bisa diambil
            }
            
            return {
                id: chat.id._serialized,
                name: chat.name || chat.formattedTitle || chat.id.user,
                isGroup: chat.isGroup,
                unreadCount: chat.unreadCount,
                timestamp: chat.timestamp || (lastMsg ? lastMsg.timestamp : null),
                lastMessage: lastMsg ? lastMsg.body : null,
                profilePic: profilePic
            };
        }));
        
        res.status(200).json({
            status: true,
            message: "Berhasil mengambil daftar chat.",
            data: chatList
        });
    } catch (error) {
        console.error(`[${req.params.clientId}] ❌ Gagal mengambil chat:`, error);
        res.status(500).json({ status: false, message: 'Gagal mengambil daftar chat', error: error.message });
    }
});

app.post('/api/messages/:clientId', isAuthorized, [ body('number').notEmpty() ], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(422).json({ status: false, errors: errors.array() });
    }
    
    try {
        const number = phoneNumberFormatter(req.body.number);
        const chat = await req.client.getChatById(number);
        
        const messagesRaw = await chat.fetchMessages({ limit: 25 }); // Ambil 25 pesan terakhir
        
        const messages = await Promise.all(messagesRaw.map(async (msg) => {
            let mediaData = null;
            
            if (msg.hasMedia && ['image', 'video', 'document', 'audio', 'ptt'].includes(msg.type)) {
                try {
                    const media = await msg.downloadMedia();
                    if (media) {
                        mediaData = {
                            mimetype: media.mimetype,
                            data: `data:${media.mimetype};base64,${media.data}`,
                            filename: media.filename || `media-${msg.timestamp}.${media.mimetype.split('/')[1]}`
                        };
                    }
                } catch (e) {
                    console.error(`[${req.params.clientId}] Gagal mengunduh media untuk pesan ${msg.id._serialized}:`, e.message);
                }
            }
            
            return {
                id: msg.id._serialized,
                fromMe: msg.fromMe,
                from: msg.from,
                to: msg.to,
                body: msg.body || '',
                timestamp: msg.timestamp,
                type: msg.type,
                hasMedia: msg.hasMedia,
                media: mediaData
            };
        }));
        
        res.status(200).json({
            status: true,
            message: "Berhasil mengambil pesan.",
            data: messages
        });
        
    } catch (error) {
        console.error(`[${req.params.clientId}] ❌ Gagal mengambil pesan:`, error);
        // Menambahkan pengecekan jika chat tidak ditemukan
        if (error.message.includes('Chat not found')) {
            return res.status(404).json({ status: false, message: "Chat tidak ditemukan. Pastikan nomor sudah pernah berinteraksi." });
        }
        res.status(500).json({ status: false, message: 'Gagal mengambil pesan', error: error.message });
    }
});

server.listen(port, () => {
    console.log(`Server WhatsApp Gateway Dinamis (AMAN) berjalan di http://localhost:${port}`);
    if (CLIENT_IDS.length === 0) console.warn("PERINGATAN: Tidak ada klien yang dikonfigurasi.");
    else console.log("Klien yang aktif:", CLIENT_IDS.join(', '));
});