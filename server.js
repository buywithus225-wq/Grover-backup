const express = require('express');
const cors = require('cors');
const { initializeApp, cert, getFirestore, FieldValue } = require('firebase-admin');
const crypto = require('crypto');

// 1. Initialize Firebase
let serviceAccount;
if (process.env.FIREBASE_KEY) {
  serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
} else {
  serviceAccount = require('./serviceAccountKey.json');
}

initializeApp({
  credential: cert(serviceAccount)
});

const db = getFirestore();

// 2. Setup Express Server
const app = express();
app.use(cors());
app.use(express.json());

const BOT_TOKEN = '8870298376:AAH_9bg2YK0O5Rc4CBzgZIxWloV0Rcuf9ns'; // <--- CHANGE THIS

function verifyTelegramData(initData) {
  const urlParams = new URLSearchParams(initData);
  const hash = urlParams.get('hash');
  urlParams.delete('hash');
  urlParams.sort();
  let dataCheckString = '';
  for (const [key, value] of urlParams.entries()) {
    dataCheckString += `${key}=${value}\n`;
  }
  dataCheckString = dataCheckString.slice(0, -1);
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (calculatedHash === hash) {
    const user = JSON.parse(urlParams.get('user'));
    return { isValid: true, user: user };
  }
  return { isValid: false };
}

app.get('/', (req, res) => res.json({ status: "Grover Backend is alive" }));

app.post('/api/sync', async (req, res) => {
  try {
    const { initData } = req.body;
    const auth = verifyTelegramData(initData);
    if (!auth.isValid) return res.status(401).json({ error: "Unauthorized" });
    const userId = String(auth.user.id);
    const userRef = db.collection('users').doc(userId);
    const doc = await userRef.get();
    if (!doc.exists) {
      await userRef.set({ username: auth.user.username || 'Unknown', balance: 0, diamonds: 0, hasPaid: false, referralCount: 0, vipLevel: 1, lastClaimTime: Date.now(), checkinDay: 1, lastCheckin: null, extraSpinsUsed: 0, lastSpin: null });
      return res.json({ isNew: true, user: { balance: 0, diamonds: 0, hasPaid: false, vipLevel: 1 } });
    }
    res.json({ isNew: false, user: doc.data() });
  } catch (error) { res.status(500).json({ error: "Server Error" }); }
});

app.post('/api/claim', async (req, res) => {
  try {
    const { initData } = req.body;
    const auth = verifyTelegramData(initData);
    if (!auth.isValid) return res.status(401).json({ error: "Unauthorized" });
    const userId = String(auth.user.id);
    const userRef = db.collection('users').doc(userId);
    const doc = await userRef.get();
    const data = doc.data();
    if (Date.now() - data.lastClaimTime < 86400000) return res.status(400).json({ error: "Mining not ready" });
    let rate = 5 * data.vipLevel;
    await userRef.update({ balance: data.balance + rate, lastClaimTime: Date.now() });
    res.json({ success: true, newBalance: data.balance + rate });
  } catch (error) { res.status(500).json({ error: "Server Error" }); }
});

app.post('/api/spin', async (req, res) => {
  try {
    const { initData, isRespin } = req.body;
    const auth = verifyTelegramData(initData);
    if (!auth.isValid) return res.status(401).json({ error: "Unauthorized" });
    const userId = String(auth.user.id);
    const userRef = db.collection('users').doc(userId);
    const doc = await userRef.get();
    const data = doc.data();
    const today = new Date().toDateString();
    if (!isRespin && data.lastSpin === today) {
      if (data.extraSpinsUsed >= 10) return res.status(400).json({ error: "Daily limit reached" });
    }
    const prize = Math.floor(Math.random() * 6) + 1;
    const updateData = { balance: data.balance + prize };
    if (!isRespin) { updateData.lastSpin = today; } 
    else { updateData.extraSpinsUsed = (data.extraSpinsUsed || 0) + 1; }
    await userRef.update(updateData);
    res.json({ success: true, prize: prize, newBalance: data.balance + prize });
  } catch (error) { res.status(500).json({ error: "Server Error" }); }
});

app.post('/api/p2p', async (req, res) => {
  try {
    const { initData, recipientCode, amount } = req.body;
    const auth = verifyTelegramData(initData);
    if (!auth.isValid) return res.status(401).json({ error: "Unauthorized" });
    const senderId = String(auth.user.id);
    if (amount <= 0 || amount > 10000) return res.status(400).json({ error: "Invalid amount" });
    const senderRef = db.collection('users').doc(senderId);
    const doc = await senderRef.get();
    const data = doc.data();
    const fee = amount * 0.05;
    const totalDeducted = amount + fee;
    if (data.balance < totalDeducted) return res.status(400).json({ error: "Insufficient balance" });
    await senderRef.update({ balance: data.balance - totalDeducted });
    res.json({ success: true, message: "Sent successfully" });
  } catch (error) { res.status(500).json({ error: "Server Error" }); }
});

app.post('/api/withdraw-diamond', async (req, res) => {
  try {
    const { initData, walletAddress } = req.body;
    const auth = verifyTelegramData(initData);
    if (!auth.isValid) return res.status(401).json({ error: "Unauthorized" });
    const userId = String(auth.user.id);
    const userRef = db.collection('users').doc(userId);
    const doc = await userRef.get();
    const data = doc.data();
    if (data.diamonds < 1) return res.status(400).json({ error: "You need a Diamond to withdraw!" });
    await userRef.update({ diamonds: data.diamonds - 1 });
    await db.collection('withdrawal_requests').add({ userId: userId, type: 'Diamond', amount: 1, walletAddress: walletAddress, status: 'Pending', createdAt: FieldValue.serverTimestamp() });
    res.json({ success: true, message: "Request submitted!" });
  } catch (error) { res.status(500).json({ error: "Server Error" }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Running on port ${PORT}`));
