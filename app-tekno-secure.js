const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const fs = require('fs');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const { body, validationResult } = require('express-validator');
const qrcode = require('qrcode');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

process.on('unhandledRejection', (reason) => {
    const msg = reason && reason.message ? reason.message : String(reason);
    if (msg.includes('Evaluation failed') || msg.includes('onCodeReceivedEvent') || msg.includes('requestPairingCode')) {
        console.warn('[PAIRING WARNING] Error pairing ditahan agar server tidak crash:', msg);
        return;
    }
    console.error('[UNHANDLED REJECTION]', reason);
});

process.on('uncaughtException', (error) => {
    const msg = error && error.message ? error.message : String(error);
    if (msg.includes('Evaluation failed') || msg.includes('onCodeReceivedEvent') || msg.includes('requestPairingCode')) {
        console.warn('[PAIRING WARNING] Exception pairing ditahan agar server tidak crash:', msg);
        return;
    }
    console.error('[UNCAUGHT EXCEPTION]', error);
});

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
const qrCache = {}; // Cache untuk menyimpan QR code terakhir dan debounce
const QR_DEBOUNCE_TIME = 2000; // Debounce 2 detik untuk QR events
const qrCounts = {}; // Hitungan jumlah QR yang sudah digenerate per klien
const QR_LIMIT = 20; // Batas maksimal generate QR sebelum diblokir
const wwebjsVersion = require('whatsapp-web.js/package.json').version;

const AUTH_MAX_GENERATE = 10;
const authFlow = {};

// Helper login WhatsApp via nomor HP / pairing code.
// Format yang dibutuhkan wwebjs: nomor internasional tanpa simbol, contoh 6281234567890.
const normalizePairingPhoneNumber = (phoneNumber) => {
    let cleanNumber = String(phoneNumber || '').replace(/\D/g, '');

    // Shortcut Indonesia: 0812xxxx -> 62812xxxx, 812xxxx -> 62812xxxx
    if (cleanNumber.startsWith('0')) cleanNumber = `62${cleanNumber.slice(1)}`;
    if (cleanNumber.startsWith('8')) cleanNumber = `62${cleanNumber}`;

    return cleanNumber;
};

const initAuthFlow = (clientId, mode = 'qr', phoneNumber = null) => {
    authFlow[clientId] = {
        mode,
        count: 0,
        paused: false,
        lastPhoneNumber: phoneNumber,
        updatedAt: Date.now()
    };
    return authFlow[clientId];
};

const deleteClientSession = (clientId) => {
    const sessionPath = path.join(__dirname, 'sessions', `session-${clientId}`);
    try {
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log(`[${clientId}] Session lama dihapus sebelum retry pairing/QR.`);
        }
    } catch (error) {
        console.warn(`[${clientId}] Gagal menghapus session lama:`, error.message);
    }
};

const destroyClientSafely = async (clientId) => {
    if (clients[clientId]) {
        try {
            await clients[clientId].destroy();
        } catch (e) {
            console.warn(`[${clientId}] Gagal destroy client:`, e.message);
        }
        delete clients[clientId];
    }
};

const pauseAuthFlow = async (clientId, mode) => {
    const state = authFlow[clientId];
    if (!state || state.paused) return;

    state.paused = true;
    state.updatedAt = Date.now();

    io.to(clientId).emit('auth_limit_reached', {
        clientId,
        mode: mode || state.mode || 'qr',
        count: state.count,
        limit: AUTH_MAX_GENERATE,
        phoneNumber: state.lastPhoneNumber || null
    });

    io.to(clientId).emit(
        'message',
        `Sudah ${AUTH_MAX_GENERATE}x update ${mode === 'pairing' ? 'pairing code' : 'QR code'}. Menunggu konfirmasi user untuk melanjutkan.`
    );

    // Stop generate berikutnya dengan menghentikan client saat ini.
    await destroyClientSafely(clientId);
};

const markAuthGeneration = async (clientId, mode, phoneNumber = null) => {
    const state = authFlow[clientId] || initAuthFlow(clientId, mode, phoneNumber);
    state.mode = mode || state.mode || 'qr';
    if (phoneNumber) state.lastPhoneNumber = phoneNumber;
    state.count = (state.count || 0) + 1;
    state.updatedAt = Date.now();

    if (state.count >= AUTH_MAX_GENERATE) {
        await pauseAuthFlow(clientId, state.mode);
        return false;
    }
    return true;
};

const resumeAuthFlow = async (clientId) => {
    const state = authFlow[clientId];
    if (!state) throw new Error('State autentikasi belum ditemukan.');

    state.paused = false;
    state.count = 0;
    state.updatedAt = Date.now();

    // Hentikan client lama bila masih ada, lalu start ulang sesuai mode terakhir.
    await destroyClientSafely(clientId);

    if (state.mode === 'pairing') {
        deleteClientSession(clientId);
        if (!state.lastPhoneNumber) {
            throw new Error('Nomor HP pairing terakhir tidak ditemukan.');
        }
        await initializeWhatsApp(clientId, { pairPhoneNumber: state.lastPhoneNumber });
        return;
    }

    await initializeWhatsApp(clientId);
};

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

const initializeWhatsApp = async (clientId, options = {}) => {
    const { pairPhoneNumber = null } = options;

    // Jika klien sudah diblokir karena terlalu banyak QR, jangan inisialisasi ulang sampai regenerate.
    // Mode pairing nomor HP boleh melewati status qr_blocked karena client akan dibuat ulang.
    if (!pairPhoneNumber && clientStates[clientId] && clientStates[clientId].status === 'qr_blocked') {
        console.log(`[${clientId}] Inisialisasi dibatalkan karena status qr_blocked.`);
        return;
    }

    // Cek apakah sudah ada instance yang sedang berjalan atau aktif.
    if (clients[clientId] || clientInits[clientId]) {
        console.log(`[${clientId}] Inisialisasi sudah berjalan atau client aktif.`);
        return;
    }

    clientInits[clientId] = true;
    console.log(`Menginisialisasi WhatsApp untuk ${clientId}${pairPhoneNumber ? ' dengan pairing nomor HP' : ''}...`);

    qrCounts[clientId] = qrCounts[clientId] || 0;
    initAuthFlow(clientId, pairPhoneNumber ? 'pairing' : 'qr', pairPhoneNumber);
    clientStates[clientId] = { status: 'loading', data: null };
    io.to(clientId).emit(pairPhoneNumber ? 'loading_screen_pairing' : 'loading_screen');

    const clientOptions = {
        restartOnAuthFail: false,
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--disable-gpu',
                '--no-zygote',
                '--single-process',
                '--proxy-server="direct://"',
                '--proxy-bypass-list=*',
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                '--disable-extensions',
                '--disable-default-apps',
                '--mute-audio',
                '--no-default-browser-check',
                '--autoplay-policy=user-gesture-required',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--disk-cache-size=0',
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
    };

    // Mode login nomor HP. Ini lebih stabil daripada memanggil requestPairingCode()
    // secara manual pada client QR yang sudah berjalan.
    if (pairPhoneNumber) {
        clientOptions.pairWithPhoneNumber = {
            phoneNumber: pairPhoneNumber,
            showNotification: true,
            intervalMs: 180000
        };
    }

    const client = new Client(clientOptions);
    clients[clientId] = client;

    const cleanupAuthCaches = () => {
        if (qrCache[clientId]) {
            qrCache[clientId].imageUrl = null;
            delete qrCache[clientId];
        }
        if (qrCounts[clientId]) delete qrCounts[clientId];
    };

    const handleQrEvent = async (qr) => {
        // Jika client sedang dibuat untuk pairing code, abaikan QR agar UI tidak bentrok.
        if (pairPhoneNumber) return;

        clientInits[clientId] = false;

        if (clientStates[clientId] && clientStates[clientId].status === 'qr_blocked') {
            return;
        }

        const now = Date.now();
        if (qrCache[clientId]) {
            const { qrString, timestamp, imageUrl } = qrCache[clientId];

            if (qrString === qr && (now - timestamp) < QR_DEBOUNCE_TIME) {
                return;
            }

            if (imageUrl) {
                qrCache[clientId].imageUrl = null;
            }
        }

        try {
            qrCounts[clientId] = (qrCounts[clientId] || 0) + 1;

            console.log(`[${clientId}] QR Code diterima.`);
            const qrImage = await qrcode.toDataURL(qr);
            clientStates[clientId] = { status: 'qr', data: qrImage, count: qrCounts[clientId] };

            qrCache[clientId] = {
                qrString: qr,
                timestamp: now,
                imageUrl: qrImage
            };

            io.to(clientId).emit('qr', qrImage);
            io.to(clientId).emit('message', 'Silakan pindai QRCode atau pilih login menggunakan Nomor HP.');

            await markAuthGeneration(clientId, 'qr');

        } catch (err) {
            console.error(`[${clientId}] Error generating QR code:`, err);
            io.to(clientId).emit('message', `Gagal membuat QR: ${err.message}`);
        }
    };

    client.on('qr', handleQrEvent);

    // Event ini keluar otomatis dari wwebjs saat options.pairWithPhoneNumber dipakai.
    client.on('code', async (code) => {
        const formattedCode = String(code || '').replace(/\s/g, '').match(/.{1,4}/g)?.join('-') || code;
        console.log(`[${clientId}] Pairing Code diterima: ${formattedCode}`);

        clientInits[clientId] = false;
        clientStates[clientId] = {
            status: 'pairing_code',
            data: code,
            phoneNumber: pairPhoneNumber,
            createdAt: Date.now()
        };

        io.to(clientId).emit('pairing_code_result', { code, phoneNumber: pairPhoneNumber });
        io.to(clientId).emit('message', 'Pairing code berhasil dibuat. Buka WhatsApp di HP lalu masukkan kode tautan perangkat.');

        await markAuthGeneration(clientId, 'pairing', pairPhoneNumber);
    });

    client.on('ready', () => {
        console.log(`[${clientId}] SIAP!`);
        clientInits[clientId] = false;
        clientStates[clientId] = { status: 'ready', data: null };

        cleanupAuthCaches();

        io.to(clientId).emit('ready');
        io.to(clientId).emit('message', `[${clientId}] Terhubung.`);
    });

    client.on('message', async (msg) => {
        try {
            const chat = await msg.getChat();
            const contact = await msg.getContact();
            const profilePic = await contact.getProfilePicUrl().catch(() => '');

            io.to(clientId).emit('new_message', {
                from: msg.from,
                body: msg.body,
                name: chat.name,
                timestamp: msg.timestamp,
                profilePic: profilePic,
                unreadCount: chat.unreadCount
            });
        } catch (error) {
            console.error(`[${clientId}] Gagal memproses pesan masuk:`, error.message);
        }
    });

    client.on('authenticated', () => {
        clientStates[clientId] = { status: 'authenticated', data: null };
        io.to(clientId).emit('authenticated');
    });

    client.on('auth_failure', (message) => {
        clientInits[clientId] = false;
        clientStates[clientId] = { status: 'auth_failure', data: null };
        io.to(clientId).emit('message', `[${clientId}] Autentikasi gagal${message ? `: ${message}` : '.'}`);
    });

    client.on('disconnected', async (reason) => {
        console.log(`[${clientId}] Terputus: ${reason}`);
        io.to(clientId).emit('message', `[${clientId}] terputus, ${reason}.`);
        clientStates[clientId] = { status: 'disconnected', data: null };
        clientInits[clientId] = false;

        cleanupAuthCaches();

        try {
            await client.destroy();
        } catch (e) {}

        delete clients[clientId];

        if (reason === 'LOGOUT') {
            const sessionPath = `./sessions/session-${clientId}`;
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
        clientStates[clientId] = { status: 'init_failed', data: null };
        console.error(`[${clientId}] Gagal:`, err);
        io.to(clientId).emit('pairing_code_error', `Gagal inisialisasi WhatsApp: ${err.message || err}`);
        io.to(clientId).emit('message', `Gagal inisialisasi WhatsApp: ${err.message || err}`);
    });
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
                if (clientStates[clientId] && clientStates[clientId].status === 'qr_blocked') {
                    socket.emit('qr_limit_reached', { count: clientStates[clientId].count || 0, limit: QR_LIMIT });
                } else {
                    initializeWhatsApp(clientId);
                }
            } else {
                const currentState = clientStates[clientId];
                if (currentState) {
                    // Kirim status terakhir agar UI sinkron tanpa refresh
                    if (currentState.status === 'qr') socket.emit('qr', currentState.data);
                    if (currentState.status === 'pairing_code') socket.emit('pairing_code_result', { code: currentState.data, phoneNumber: currentState.phoneNumber });
                    if (currentState.status === 'qr_blocked') socket.emit('qr_limit_reached', { count: currentState.count || 0, limit: QR_LIMIT });
                    if (currentState.status === 'ready') socket.emit('ready');
                }
            }
        }
    });

    // Event dari frontend untuk meregenerasi QR secara manual (setelah dibatasi)
    socket.on('regenerate_qr', async (clientId) => {
        if (!CLIENT_IDS.includes(clientId)) return socket.emit('message', 'Klien tidak ditemukan.');

        // Reset counter, state, dan cache agar inisialisasi bisa dijalankan ulang
        qrCounts[clientId] = 0;
        clientStates[clientId] = { status: 'loading', data: null };
        if (qrCache[clientId]) {
            qrCache[clientId].imageUrl = null;
            delete qrCache[clientId];
        }

        socket.emit('message', `Regenerating QR untuk ${clientId}...`);

        try {
            if (clients[clientId]) {
                try { await clients[clientId].destroy(); } catch (e) {}
                delete clients[clientId];
            }
            // Re-inisialisasi client untuk memaksa generate QR baru
            initializeWhatsApp(clientId);
        } catch (e) {
            socket.emit('message', `Gagal meregenerasi QR: ${e.message}`);
        }
    });

    // --- TAMBAHAN: Event untuk login WA memakai nomor HP / pairing code ---
    socket.on('request_pairing_code', async (data = {}) => {
        const { clientId, phoneNumber } = data;

        if (!CLIENT_IDS.includes(clientId)) {
            socket.emit('pairing_code_error', 'Klien tidak ditemukan.');
            return socket.emit('message', 'Klien tidak ditemukan.');
        }

        const cleanNumber = normalizePairingPhoneNumber(phoneNumber);

        if (!/^62\d{8,15}$/.test(cleanNumber)) {
            socket.emit('pairing_code_error', 'Format nomor tidak valid. Contoh: 6281234567890 atau 081234567890.');
            return socket.emit('message', 'Format nomor tidak valid.');
        }

        try {
            socket.join(clientId);
            socket.emit('message', `Memulai login nomor HP untuk ${cleanNumber}...`);

            // Hentikan client QR yang sedang berjalan supaya tidak bentrok dengan mode pairing code.
            await destroyClientSafely(clientId);

            clientInits[clientId] = false;
            qrCounts[clientId] = 0;

            if (qrCache[clientId]) {
                qrCache[clientId].imageUrl = null;
                delete qrCache[clientId];
            }

            initAuthFlow(clientId, 'pairing', cleanNumber);
            clientStates[clientId] = { status: 'loading', data: null };
            io.to(clientId).emit('loading_screen_pairing');

            await initializeWhatsApp(clientId, {
                pairPhoneNumber: cleanNumber
            });
        } catch (error) {
            console.error(`[${clientId}] Gagal mulai pairing code:`, error);
            socket.emit('pairing_code_error', `Gagal mendapatkan pairing code: ${error.message}`);
            socket.emit('message', `Gagal mendapatkan pairing code: ${error.message}`);
        }
    });

    socket.on('auth_retry', async (data = {}) => {
        const { clientId } = data;
        if (!CLIENT_IDS.includes(clientId)) {
            return socket.emit('message', 'Klien tidak ditemukan.');
        }

        const state = authFlow[clientId];
        if (!state) {
            return socket.emit('message', 'State autentikasi belum tersedia.');
        }

        try {
            socket.emit('message', `Melanjutkan login mode ${state.mode}...`);
            state.paused = false;
            state.count = 0;

            await resumeAuthFlow(clientId);
        } catch (error) {
            console.error(`[${clientId}] Gagal retry autentikasi:`, error);
            socket.emit('pairing_code_error', `Gagal melanjutkan autentikasi: ${error.message}`);
            socket.emit('message', `Gagal melanjutkan autentikasi: ${error.message}`);
        }
    });

    socket.emit('app_info', {
        wwebjsVersion: wwebjsVersion
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
        
        // Cleanup QR cache
        if (qrCache[clientId]) {
            qrCache[clientId].imageUrl = null;
            delete qrCache[clientId];
        }
        // Cleanup QR counter
        if (qrCounts[clientId]) delete qrCounts[clientId];
        
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
        // Tambahkan pengecekan tambahan pada objek internal
        if (!req.client || !req.client.pupPage || req.client.pupPage.isClosed()) {
            throw new Error('Browser belum siap atau halaman tertutup.');
        }
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
            let contact = null;
            try {
                contact = await chat.getContact();
                profilePic = await req.client.getProfilePicUrl(chat.id._serialized);
            } catch (e) {
                profilePic = null; // Abaikan jika foto profil tidak bisa diambil
            }
            // LOGIKA RESOLUSI ID:
            // Jika ID menggunakan @lid dan bukan grup, ubah menjadi @c.us menggunakan nomor asli
            let resolvedId = chat.id._serialized;
            if (!chat.isGroup && resolvedId.endsWith('@lid')) {
                if (contact && contact.number) {
                    resolvedId = contact.number + '@c.us';
                }
            }
            
            return {
                id: resolvedId,
                // name: chat.name || chat.formattedTitle || formattedNumber,
                name: chat.name || contact?.pushname || contact?.name || chat.id.user,
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
// Fungsi pembantu untuk membuat delay
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const autoInitialize = async () => {
    console.log("Memulai pemeriksaan sesi dengan sistem antrean...");
    
    for (const id of CLIENT_IDS) {
        const sessionPath = path.join(__dirname, 'sessions', `session-${id}`);
        
        if (fs.existsSync(sessionPath)) {
            console.log(`[${id}] Sesi ditemukan. Mengantre inisialisasi...`);
            
            // Tunggu 10 detik sebelum menjalankan akun berikutnya
            await initializeWhatsApp(id);
            await delay(90000); 
        } else {
            console.log(`[${id}] Belum ada sesi, dilewati.`);
        }
    }
};

// Panggil fungsi ini di bagian bawah sebelum server.listen
autoInitialize();
server.listen(port, () => {
    console.log(`Server WhatsApp Gateway Dinamis (AMAN) berjalan di http://localhost:${port}`);
    if (CLIENT_IDS.length === 0) console.warn("PERINGATAN: Tidak ada klien yang dikonfigurasi.");
    else console.log("Klien yang aktif:", CLIENT_IDS.join(', '));
});