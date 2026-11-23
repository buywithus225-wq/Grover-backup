const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');

// --- SECRETS (Loaded safely from Render Environment Variables) ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_PIN = process.env.ADMIN_PIN;
const FIREBASE_KEY = process.env.FIREBASE_KEY;

if (!BOT_TOKEN) throw new Error('Missing BOT_TOKEN');
if (!ADMIN_PIN) throw new Error('Missing ADMIN_PIN');
if (!FIREBASE_KEY) throw new Error('Missing FIREBASE_KEY');

const DAY_MS = 86400000;
const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;

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

// --- TELEGRAM AUTHENTICATION ---
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
    } catch (error) {
        return { isValid: false };
    }
}

function requireTelegramUser(req, res, next) {
    const auth = verifyTelegramData(req.body && req.body.initData);
    if (!auth.isValid) return res.status(401).json({ success: false, error: 'Unauthorized' });
    req.telegramUser = auth.user;
    next();
}

// --- ROUTES ---
app.get('/', (req, res) => res.json({ status: 'Grover Backend is alive' }));

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
                    lastClaimTime: 0, lastSpinDate: '', extraSpinsUsed: 0, createdAt: Date.now()
                };
                tx.set(userRef, newUser);
                return { isNew: true, user: newUser };
            }
            return { isNew: false, user: doc.data() };
        });
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: 'Server Error' });
    }
});

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
            // Set a 24-hour timer for the push notification
setTimeout(() => {
  sendMiningNotification(userId);
}, 86400000);
            return { status: 200, body: { success: true, reward, newBalance, nextClaimAt: now + DAY_MS } };
        });

        res.status(result.status).json(result.body);
    } catch (error) {
        res.status(500).json({ success: false, error: 'Server Error' });
    }
});

// --- PAYMENT ROUTE (Adds 100 GROV bonus) ---
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

// --- ADMIN ROUTES ---
app.post('/api/admin/verify', (req, res) => {
    const { pin } = req.body;
    if (pin === ADMIN_PIN) {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false });
    }
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
