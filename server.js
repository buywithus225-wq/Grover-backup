
















const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');

// 1. Initialize Firebase (Works on Render and Local)
let serviceAccount;
if (process.env.FIREBASE_KEY) {
  // On Render (Reads from Environment Variable)
  serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
} else {
  // On Termux (Reads from file)
  serviceAccount = require('./serviceAccountKey.json');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// 2. Setup Express Server
const app = express();
app.use(cors());
app.use(express.json());

// 3. Telegram Security Check (Verifies the user is real)
const BOT_TOKEN = '8870298376:AAH_9bg2YK0O5Rc4CBzgZIxWloV0Rcuf9ns'; // <--- PUT YOUR REAL TOKEN HERE

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

// 4. API Routes
app.get('/', (req, res) => {
  res.json({ status: "Grover Backend is alive", time: new Date() });
});

// Route: Sync User (Loads data when app opens)
app.post('/api/sync', async (req, res) => {
  try {
    const { initData } = req.body;
    const auth = verifyTelegramData(initData);
    if (!auth.isValid) return res.status(401).json({ error: "Unauthorized" });

    const userId = String(auth.user.id);
    const username = auth.user.username || 'Unknown';
    
    const userRef = db.collection('users').doc(userId);
    const doc = await userRef.get();

    if (!doc.exists) {
      // New User
      await userRef.set({
        username: username,
        balance: 0,
        diamonds: 0,
        hasPaid: false,
        referralCount: 0,
        vipLevel: 1,
        lastClaimTime: Date.now(),
        checkinDay: 1,
        lastCheckin: null,
        extraSpinsUsed: 0,
        lastSpin: null
      });
      return res.json({ isNew: true, user: { balance: 0, diamonds: 0, hasPaid: false, vipLevel: 1 } });
    } else {
      return res.json({ isNew: false, user: doc.data() });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Server Error" });
  }
});

// Route: Claim Mining (Prevents 24h bypass)
app.post('/api/claim', async (req, res) => {
  try {
    const { initData } = req.body;
    const auth = verifyTelegramData(initData);
    if (!auth.isValid) return res.status(401).json({ error: "Unauthorized" });

    const userId = String(auth.user.id);
    const userRef = db.collection('users').doc(userId);
    
    const doc = await userRef.get();
    const data = doc.data();
    const DAY_MS = 24 * 60 * 60 * 1000;
    
    if (Date.now() - data.lastClaimTime < DAY_MS) {
      return res.status(400).json({ error: "Mining not ready" });
    }

    let rate = 5 * data.vipLevel;
    const newBalance = data.balance + rate;

    await userRef.update({ 
      balance: newBalance, 
      lastClaimTime: Date.now() 
    });
    
    res.json({ success: true, newBalance: newBalance });
  } catch (error) {
    res.status(500).json({ error: "Server Error" });
  }
});

// Route: Spin Wheel (Server-side logic to prevent hacking)
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

    // Check limits
    if (!isRespin && data.lastSpin === today) {
      if (data.extraSpinsUsed >= 10) return res.status(400).json({ error: "Daily limit reached" });
      // In a real app, you'd verify the ad token here
    }

    // Server decides the prize (Math.random is safe enough for now, can be rigged later)
    const prize = Math.floor(Math.random() * 6) + 1;
    const newBalance = data.balance + prize;
    
    const updateData = { balance: newBalance };
    if (!isRespin) { updateData.lastSpin = today; } 
    else { updateData.extraSpinsUsed = (data.extraSpinsUsed || 0) + 1; }

    await userRef.update(updateData);
    
    res.json({ success: true, prize: prize, newBalance: newBalance });
  } catch (error) {
    res.status(500).json({ error: "Server Error" });
  }
});

// Route: P2P Transfer
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

    // Deduct from sender
    await senderRef.update({ balance: data.balance - totalDeducted });
    
    // Note: To actually give the recipient the money, you need to search the 'users' collection
    // for the user whose referralCode matches recipientCode, then add the balance to them.
    
    res.json({ success: true, message: "Sent successfully" });
  } catch (error) {
    res.status(500).json({ error: "Server Error" });
  }
});

// Route: Request Diamond Withdrawal
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
    
    await db.collection('withdrawal_requests').add({
      userId: userId,
      type: 'Diamond',
      amount: 1,
      walletAddress: walletAddress,
      status: 'Pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true, message: "Request submitted!" });
  } catch (error) {
    res.status(500).json({ error: "Server Error" });
  }
});

// 5. Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Grover Backend running on port ${PORT}`);
});
