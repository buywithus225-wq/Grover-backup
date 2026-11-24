const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');
const path = require('path');

// --- SECRETS ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_PIN = process.env.ADMIN_PIN;
const FIREBASE_KEY = process.env.FIREBASE_KEY;

if (!BOT_TOKEN) throw new Error('Missing BOT_TOKEN');
if (!ADMIN_PIN) throw new Error('Missing ADMIN_PIN');
if (!FIREBASE_KEY) throw new Error('Missing FIREBASE_KEY');

const DAY_MS = 86400000;

// --- FIREBASE INIT ---
let serviceAccount;
try {
    serviceAccount = JSON.parse(FIREBASE_KEY);
    if (serviceAccount.private_key) {
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
} catch (error) {
    throw new Error('Invalid FIREBASE_KEY format');
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();

app.use(cors());
app.use(express.json({ limit: '100kb' }));

// --- SERVE ADMIN PANEL ---
app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// --- TELEGRAM AUTH ---
function verifyTelegramData(initData) {
    try {
        if (!initData || typeof initData !== 'string') return { isValid: false };
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        if (!hash) return { isValid: false };
        
        params.delete('hash');
        params.sort();
        const dataCheckString = [...params.entries()].map(([key, value]) => `${key}=${value}`).join('\n');
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        
        if (calculatedHash !== hash) return { isValid: false };
        
        const user = JSON.parse(params.get('user'));
        return { isValid: true, user };
    } catch (error) { return { isValid: false }; }
}

function requireTelegramUser(req, res, next) {
    const auth = verifyTelegramData(req.body && req.body.initData);
    if (!auth.isValid) return res.status(401).json({ success: false, error: 'Unauthorized' });
    req.telegramUser = auth.user;
    next();
}

// --- ROUTES ---
app.get('/', (req, res) => res.json({ status: 'Grover Backend is alive' }));

// Sync User
app.post('/api/sync', requireTelegramUser, async (req, res) => {
    try {
        const user = req.telegramUser;
        const userRef = db.collection('users').doc(String(user.id));

        const result = await db.runTransaction(async tx => {
            const doc = await tx.get(userRef);
            if (!doc.exists) {
                const newUser = {
                    telegramId: String(user.id), username: user.username || '', firstName: user.first_name || '',
                    balance: 0, diamonds: 0, hasPaid: false, referralCount: 0, vipLevel: 1,
                    lastClaimTime: 0, lastSpinDate: '', extraSpinsUsed: 0, createdAt: Date.now(),
                    referralCode: 'GRV' + String(user.id).slice(-6).toUpperCase()
                };
                tx.set(userRef, newUser);
                return { isNew: true, user: newUser };
            }
            return { isNew: false, user: doc.data() };
        });
        res.json(result);
    } catch (error) { res.status(500).json({ success: false, error: 'Server Error' }); }
});

// Claim Mining
app.post('/api/claim', requireTelegramUser, async (req, res) => {
    try {
        const userId = String(req.telegramUser.id);
        const userRef = db.collection('users').doc(userId);
        const now = Date.now();

        const result = await db.runTransaction(async tx => {
            const doc = await tx.get(userRef);
            if (!doc.exists) return { status: 404, body: { success: false, error: 'User not found' } };
            
            const data = doc.data() || {};
            const lastClaimTime = Number(data.lastClaimTime || 0);
            const elapsed = now - lastClaimTime;

            if (elapsed < DAY_MS) {
                return { status: 400, body: { success: false, error: 'Mining not ready', remainingMs: DAY_MS - elapsed } };
            }

            const vipLevel = Math.min(6, Math.max(1, Math.floor(Number(data.vipLevel) || 1)));
            const reward = 5 * vipLevel;
            const newBalance = Number(data.balance || 0) + reward;

            tx.update(userRef, { balance: newBalance, lastClaimTime: now });
            return { status: 200, body: { success: true, reward, newBalance, nextClaimAt: now + DAY_MS } };
        });

        // Trigger notification after successful claim
        if (result.status === 200) {
            setTimeout(() => { sendMiningNotification(userId); }, DAY_MS);
        }

        res.status(result.status).json(result.body);
    } catch (error) { res.status(500).json({ success: false, error: 'Server Error' }); }
});

// Pay Entry Fee (Gives 100 Bonus)
app.post('/api/pay', requireTelegramUser, async (req, res) => {
    try {
        const userId = String(req.telegramUser.id);
        const userRef = db.collection('users').doc(userId);
        const doc = await userRef.get();
        
        if (!doc.exists || doc.data().hasPaid === false) {
            await userRef.set({ hasPaid: true, balance: 100 }, { merge: true });
        } else {
            await userRef.set({ hasPaid: true }, { merge: true });
        }
        res.json({ success: true, message: "Payment saved" });
    } catch (error) { res.status(500).json({ success: false, error: "Server Error" }); }
});

// P2P Transfer
app.post('/api/p2p', requireTelegramUser, async (req, res) => {
    try {
        const { recipientCode, amount } = req.body;
        const senderId = String(req.telegramUser.id);
        if (!recipientCode || amount <= 0 || amount > 10000) return res.status(400).json({ success: false, error: 'Invalid data' });

        const senderRef = db.collection('users').doc(senderId);
        const senderDoc = await senderRef.get();
        const senderData = senderDoc.data();

        const fee = amount * 0.05;
        const totalDeducted = amount + fee;
        if (senderData.balance < totalDeducted) return res.status(400).json({ success: false, error: 'Insufficient balance' });

        const usersRef = db.collection('users');
        const snapshot = await usersRef.where('referralCode', '==', recipientCode).get();
        if (snapshot.empty) return res.status(404).json({ success: false, error: 'Recipient not found' });

        const recipientDoc = snapshot.docs[0];
        const recipientData = recipientDoc.data();

        await db.runTransaction(async (t) => {
            t.update(senderRef, { balance: senderData.balance - totalDeducted });
            t.update(db.collection('users').doc(recipientDoc.id), { balance: recipientData.balance + amount });
            
            t.set(db.collection('transactions').doc(), { type: 'P2P Sent', userId: senderId, amount: amount, fee: fee, to: recipientCode, date: Date.now() });
            t.set(db.collection('transactions').doc(), { type: 'P2P Received', userId: recipientDoc.id, amount: amount, from: senderData.referralCode, date: Date.now() });
        });

        res.json({ success: true, newBalance: senderData.balance - totalDeducted });
    } catch (error) { res.status(500).json({ success: false, error: 'Server Error' }); }
});

// Deduct GROV (Mystery Box / Scratch Card)
app.post('/api/deduct-grov', requireTelegramUser, async (req, res) => {
    try {
        const { amount, action } = req.body;
        const userId = String(req.telegramUser.id);
        const userRef = db.collection('users').doc(userId);
        const doc = await userRef.get();
        const data = doc.data();

        if (data.balance < amount) return res.status(400).json({ success: false, error: 'Insufficient balance' });

        await db.runTransaction(async (t) => {
            t.update(userRef, { balance: data.balance - amount });
            t.set(db.collection('transactions').doc(), { type: action, userId: userId, amount: -amount, date: Date.now() });
        });

        res.json({ success: true, newBalance: data.balance - amount });
    } catch (error) { res.status(500).json({ success: false, error: 'Server Error' }); }
});

// Request Withdrawal (Pending)
app.post('/api/withdraw', requireTelegramUser, async (req, res) => {
    try {
        const { amount, walletAddress } = req.body;
        const userId = String(req.telegramUser.id);
        const userRef = db.collection('users').doc(userId);
        const doc = await userRef.get();
        const data = doc.data();

        if (data.balance < amount || amount < 1000) return res.status(400).json({ success: false, error: 'Invalid amount' });

        await db.runTransaction(async (t) => {
            t.update(userRef, { balance: data.balance - amount });
            t.set(db.collection('withdrawals').doc(), { userId: userId, amount: amount, walletAddress: walletAddress, status: 'Pending', date: Date.now() });
            t.set(db.collection('transactions').doc(), { type: 'Withdrawal (Pending)', userId: userId, amount: -amount, date: Date.now() });
        });

        res.json({ success: true, newBalance: data.balance - amount });
    } catch (error) { res.status(500).json({ success: false, error: 'Server Error' }); }
});

// Get Transactions (History)
app.post('/api/transactions', requireTelegramUser, async (req, res) => {
    try {
        const userId = String(req.telegramUser.id);
        const snapshot = await db.collection('transactions').where('userId', '==', userId).orderBy('date', 'desc').limit(15).get();
        const transactions = [];
        snapshot.forEach(doc => transactions.push(doc.data()));
        res.json({ success: true, transactions });
    } catch (error) { res.status(500).json({ success: false, error: 'Server Error' }); }
});

// --- ADMIN ROUTES ---
app.post('/api/admin/verify', (req, res) => {
    const { pin } = req.body;
    if (pin === ADMIN_PIN) res.json({ success: true });
    else res.status(401).json({ success: false });
});

app.get('/api/admin/withdrawals', async (req, res) => {
    const { pin } = req.query;
    if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Unauthorized' });
    const snapshot = await db.collection('withdrawals').where('status', '==', 'Pending').get();
    res.json(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
});

app.post('/api/admin/approve-withdrawal', async (req, res) => {
    const { withdrawalId } = req.body;
    await db.collection('withdrawals').doc(withdrawalId).update({ status: 'Approved' });
    res.json({ success: true });
});

app.post('/api/admin/reject-withdrawal', async (req, res) => {
    try {
        const { withdrawalId } = req.body;
        const wDoc = await db.collection('withdrawals').doc(withdrawalId).get();
        if (!wDoc.exists) return res.status(404).json({ error: 'Not found' });
        
        const wData = wDoc.data();
        const userRef = db.collection('users').doc(wData.userId);
        const userDoc = await userRef.get();
        
        await db.runTransaction(async (t) => {
            t.update(userRef, { balance: userDoc.data().balance + wData.amount });
            t.update(db.collection('withdrawals').doc(withdrawalId), { status: 'Rejected' });
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server Error' }); }
});

// --- 24-HOUR PUSH NOTIFICATION ---
async function sendMiningNotification(chatId) {
    try {
        const message = "⛏️ *Your mining is full!* \n\nTap below to open Grover Miner and claim your GROV!";
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: message,
                parse_mode: 'Markdown',
                reply_markup: { 
                    inline_keyboard: [[ 
                        { text: "💰 Open Grover Miner", web_app: { url: "https://grover-miner-app.onrender.com/" } } 
                    ]] 
                }
            })
        });
    } catch (e) { console.log("Notification failed:", e); }
}

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Backend running on port ${PORT}`));
