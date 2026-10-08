const express = require('express');
const cors = require('cors');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const PROJECT_WALLET = 'UQBiiE8EcQ-tRSIi4HjKnCYjGJ0Wjh5SA84xyzbc-qdq5ws2';
const ENTRY_FEE = 50000000;
const TONCENTER_API_KEY = '3d52927b8a0ce35f551859a71e37e30261a2f72aa5a9898715110a2625598597';

let serviceAccount;
try {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64 || '';
  console.log('Base64 length:', b64.length);
  serviceAccount = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
  console.log('Firebase key loaded for project:', serviceAccount.project_id);
} catch (e) {
  console.error('Firebase key error:', e.message);
  process.exit(1);
}

initializeApp({
  credential: cert(serviceAccount)
});

const db = getFirestore();

app.get('/', (req, res) => {
  res.json({ status: 'Grover backend is alive', time: new Date() });
});

app.post('/api/verify-payment', async (req, res) => {
  try {
    const telegram_id = req.body.telegram_id;
    const username = req.body.username;
    const wallet = req.body.wallet;
    const tx_hash = req.body.tx_hash;

    if (!telegram_id || !wallet || !tx_hash) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    console.log('Verifying payment for user ' + telegram_id);

    const userRef = db.collection('users').doc(String(telegram_id));
    const userDoc = await userRef.get();

    if (userDoc.exists && userDoc.data().paid === true) {
      return res.json({ success: true, already_paid: true });
    }

    const toncenterUrl = 'https://toncenter.com/api/v2/getTransactions?address=' + PROJECT_WALLET + '&limit=50&api_key=' + TONCENTER_API_KEY;
    const response = await fetch(toncenterUrl);
    const data = await response.json();

    if (!data.ok || !data.result) {
      return res.status(500).json({ error: 'Toncenter API error' });
    }

    let paymentVerified = false;
    let paymentAmount = 0;

    for (let i = 0; i < data.result.length; i++) {
      const tx = data.result[i];
      const txHash = tx.transaction_id ? tx.transaction_id.hash : null;
      if (txHash === tx_hash) {
        const inMsg = tx.in_msg;
        if (inMsg && inMsg.value) {
          const amount = parseInt(inMsg.value);
          if (amount >= ENTRY_FEE) {
            paymentVerified = true;
            paymentAmount = amount;
            break;
          }
        }
      }
    }

    if (!paymentVerified) {
      return res.status(400).json({ error: 'Payment not found or insufficient' });
    }

    await userRef.set({
      telegram_id: String(telegram_id),
      username: username || 'unknown',
      wallet: wallet,
      paid: true,
      paid_amount: paymentAmount,
      paid_at: FieldValue.serverTimestamp(),
      tx_hash: tx_hash,
      balance: 0,
      total_mined: 0,
      mining_level: 1,
      mining_rate: 5,
      last_claim: Date.now(),
      ads_watched_today: 0,
      spin_used_today: 0,
      checkin_streak: 0,
      referral_code: 'GRV' + String(telegram_id).slice(-6).toUpperCase(),
      referred_by: null,
      referral_count: 0,
      created_at: FieldValue.serverTimestamp()
    }, { merge: true });

    console.log('Payment verified for ' + telegram_id);

    return res.json({
      success: true,
      message: 'Payment verified! Mining unlocked.',
      balance: 0,
      mining_rate: 5
    });

  } catch (error) {
    console.error('Verification error:', error);
    return res.status(500).json({ error: 'Server error', details: error.message });
  }
});

app.get('/api/user-status/:telegram_id', async (req, res) => {
  try {
    const telegram_id = req.params.telegram_id;
    const userRef = db.collection('users').doc(String(telegram_id));
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.json({ exists: false, paid: false });
    }

    const data = userDoc.data();
    return res.json({
      exists: true,
      paid: data.paid === true,
      balance: data.balance || 0,
      mining_level: data.mining_level || 1,
      mining_rate: data.mining_rate || 5,
      referral_count: data.referral_count || 0
    });

  } catch (error) {
    console.error('Status check error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Grover backend running on port ' + PORT);
  console.log('Project wallet: ' + PROJECT_WALLET);
  console.log('Payment verification: ACTIVE');
});

// ============================================
// ADMIN SETTINGS ENDPOINTS (NEW)
// ============================================

app.get('/api/admin/settings', async (req, res) => {
  try {
    const doc = await db.collection('settings').doc('global').get();
    if (!doc.exists) {
      return res.json({
        fakePool: '$100',
        realPool: '$10',
        payoutDay: 30,
        maintFee: 15,
        demoMode: 'off',
        tasks: null,
        events: null,
        fakeUsers: null
      });
    }
    return res.json(doc.data());
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/save-settings', async (req, res) => {
  try {
    const body = req.body;
    const pin = body.pin;
    const settings = body.settings;
    const validPin = process.env.ADMIN_PIN || '1905';
    if (pin !== validPin) {
      return res.status(401).json({ error: 'Invalid PIN' });
    }
    await db.collection('settings').doc('global').set(settings, { merge: true });
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/global-users', async (req, res) => {
  try {
    const snapshot = await db.collection('users').count().get();
    const realCount = snapshot.data().count || 0;
    return res.json({ count: 1000 + realCount });
  } catch (e) {
    return res.json({ count: 1000 });
  }
});
