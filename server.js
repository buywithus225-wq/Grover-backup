// ========================================
// GROVER MINING BOT - BACKEND SERVER
// ========================================

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

// ========================================
// CONFIGURATION
// ========================================

// Your project wallet (where payments go)
const PROJECT_WALLET = 'UQBiiE8EcQ-tRSIi4HjKnCYjGJ0Wjh5SA84xyzbc-qdq5ws2';

// Entry fee in nanotons (0.05 TON)
const ENTRY_FEE = 50000000;

// Toncenter API key
const TONCENTER_API_KEY = '3d52927b8a0ce35f551859a71e37e30261a2f72aa5a9898715110a2625598597';

// ========================================
// FIREBASE SETUP
// ========================================

// Initialize Firebase Admin with service account
// You'll get this from Firebase Console → Project Settings → Service Accounts
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// ========================================
// API ENDPOINTS
// ========================================

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Grover backend is alive', time: new Date() });
});

// ========================================
// VERIFY PAYMENT
// User sends us a tx hash, we verify it on TON blockchain
// ========================================

app.post('/api/verify-payment', async (req, res) => {
  try {
    const { telegram_id, username, wallet, tx_hash } = req.body;

    // Validate inputs
    if (!telegram_id || !wallet || !tx_hash) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    console.log(`🔍 Verifying payment for user ${telegram_id}...`);

    // ========================================
    // STEP 1: Check if payment already verified
    // ========================================
    const userRef = db.collection('users').doc(String(telegram_id));
    const userDoc = await userRef.get();

    if (userDoc.exists && userDoc.data().paid === true) {
      return res.json({ 
        success: true, 
        message: 'Already verified',
        already_paid: true 
      });
    }

    // ========================================
    // STEP 2: Query Toncenter for the transaction
    // ========================================
    const toncenterUrl = `https://toncenter.com/api/v2/getTransactions?address=${PROJECT_WALLET}&limit=50&api_key=${TONCENTER_API_KEY}`;
    
    const response = await fetch(toncenterUrl);
    const data = await response.json();

    if (!data.ok || !data.result) {
      return res.status(500).json({ error: 'Toncenter API error' });
    }

    // ========================================
    // STEP 3: Find the specific transaction
    // ========================================
    let paymentVerified = false;
    let paymentAmount = 0;
    let paymentTime = 0;

    for (const tx of data.result) {
      // Check if transaction hash matches
      const txHash = tx.transaction_id?.hash;
      
      if (txHash === tx_hash) {
        // Check if it's an incoming message to our wallet
        const inMsg = tx.in_msg;
        
        if (inMsg && inMsg.value) {
          const amount = parseInt(inMsg.value);
          
          // Check if payment is at least the entry fee
          if (amount >= ENTRY_FEE) {
            paymentVerified = true;
            paymentAmount = amount;
            paymentTime = tx.utime;
            break;
          }
        }
      }
    }

    if (!paymentVerified) {
      return res.status(400).json({ 
        error: 'Payment not found or insufficient',
        message: 'We could not verify your payment. Please try again.'
      });
    }

    // ========================================
    // STEP 4: Save verified user to Firestore
    // ========================================
    const userData = {
      telegram_id: String(telegram_id),
      username: username || 'unknown',
      wallet: wallet,
      paid: true,
      paid_amount: paymentAmount,
      paid_at: admin.firestore.FieldValue.serverTimestamp(),
      tx_hash: tx_hash,
      // Mining defaults
      balance: 0,
      total_mined: 0,
      mining_level: 1,
      mining_rate: 1,
      last_collect: Date.now(),
      // Stats
      ads_watched_today: 0,
      spin_used_today: 0,
      checkin_streak: 0,
      // Referral
      referral_code: generateReferralCode(telegram_id),
      referred_by: null,
      // Timestamps
      created_at: admin.firestore.FieldValue.serverTimestamp()
    };

    await userRef.set(userData, { merge: true });

    console.log(`✅ Payment verified for ${telegram_id}, amount: ${paymentAmount}`);

    return res.json({
      success: true,
      message: 'Payment verified! Mining unlocked.',
      balance: 0,
      mining_rate: 1
    });

  } catch (error) {
    console.error('Verification error:', error);
    return res.status(500).json({ 
      error: 'Server error',
      details: error.message 
    });
  }
});

// ========================================
// CHECK USER STATUS
// Called when app opens - tells us if user has paid
// ========================================

app.get('/api/user-status/:telegram_id', async (req, res) => {
  try {
    const { telegram_id } = req.params;

    const userRef = db.collection('users').doc(String(telegram_id));
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.json({ 
        exists: false, 
        paid: false 
      });
    }

    const data = userDoc.data();

    return res.json({
      exists: true,
      paid: data.paid === true,
      balance: data.balance || 0,
      mining_level: data.mining_level || 1,
      mining_rate: data.mining_rate || 1,
      username: data.username
    });

  } catch (error) {
    console.error('Status check error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ========================================
// HELPER FUNCTIONS
// ========================================

function generateReferralCode(telegramId) {
  return 'GRV' + String(telegramId).slice(-6).toUpperCase();
}

// ========================================
// START SERVER
// ========================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Grover backend running on port ${PORT}`);
  console.log(`💰 Project wallet: ${PROJECT_WALLET}`);
  console.log(`🔒 Payment verification: ACTIVE`);
})
