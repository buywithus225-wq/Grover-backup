const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');

let serviceAccount;
if (process.env.FIREBASE_KEY) {
  serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
} else {
  serviceAccount = require('./serviceAccountKey.json');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json());

const BOT_TOKEN = '8870298376:AAH_9bg2YK0O5Rc4CBzgZIxWloV0Rcuf9ns'; // 

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
      await userRef.set({ username: auth.user.username || 'Unknown', balance: 0, diamonds: 0, hasPaid: false, referralCount: 0, vipLevel: 1, lastClaimTime: Date.now() });
      return res.json({ isNew: true, user: { balance: 0, diamonds: 0, hasPaid: false, vipLevel: 1 } });
    }
    res.json({ isNew: false, user: doc.data() });
  } catch (error) { res.status(500).json({ error: "Server Error" }); }
});


app.post('/api/sync', async (req, res) => {
  try {
    const { initData } = req.body;
    const auth = verifyTelegramData(initData);
    if (!auth.isValid) return res.status(401).json({ error: "Unauthorized" });
    
    const userId = String(auth.user.id);
    
    // --- FORCE JOIN LOGIC (Optional: Uncomment when your channel is ready) ---
    // const REQUIRED_CHANNEL = '@YourChannel';
    // try {
    //   const chatMember = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${REQUIRED_CHANNEL}&user_id=${userId}`).then(r => r.json());
    //   if (!chatMember.ok || ['left', 'kicked'].includes(chatMember.result.status)) {
    //     return res.status(403).json({ error: "JoinChannel", channel: REQUIRED_CHANNEL });
    //   }
    // } catch(e) { console.log("Channel check failed", e); }

    const userRef = db.collection('users').doc(userId);
    const doc = await userRef.get();
    if (!doc.exists) {
      // NEW USER: Automatically sets hasPaid to true for you to test
      await userRef.set({ username: auth.user.username || 'Unknown', balance: 100, diamonds: 0, hasPaid: true, referralCount: 0, vipLevel: 1, lastClaimTime: Date.now() });
      return res.json({ isNew: true, user: { balance: 100, diamonds: 0, hasPaid: true, vipLevel: 1 } });
    }
    
    // EXISTING USER: If they paid before but Firebase says false, force it to true so you can enter
    const userData = doc.data();
    if (userData.hasPaid === false) {
      await userRef.update({ hasPaid: true });
      userData.hasPaid = true;
    }
    
    res.json({ isNew: false, user: userData });
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
// ============================================
// ADMIN ROUTES & NOTIFICATIONS
// ============================================
const ADMIN_PIN = process.env.ADMIN_PIN || '1905';

app.post('/api/admin/verify', (req, res) => {
  const { pin } = req.body;
  if (pin === ADMIN_PIN) res.json({ success: true });
  else res.status(401).json({ success: false });
});

app.get('/api/admin/data', async (req, res) => {
  try {
    const settingsDoc = await db.collection('settings').doc('global').get();
    if (!settingsDoc.exists) return res.json({ fakeUsers: [], tasks: [], prizePool: '50' });
    res.json(settingsDoc.data());
  } catch (e) { res.status(500).json({ error: "Error" }); }
});

app.post('/api/admin/save', async (req, res) => {
  try {
    await db.collection('settings').doc('global').set(req.body, { merge: true });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: "Error" }); }
});

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
        reply_markup: { inline_keyboard: [[ { text: "💰 Open Grover Miner", web_app: { url: "https://buywithus225-wq.github.io/Grover-miner-app/" } } ]] }
      })
    });
  } catch (e) { console.log("Notification failed:", e); }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Running n port ${PORT}`));
