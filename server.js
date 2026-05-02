require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const { v4: uuidv4 } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 5000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:5173',
    'http://localhost:3000',
    'http://localhost:5173',
  ],
  methods: ['GET','POST','PUT','PATCH','DELETE'],
  allowedHeaders: ['Content-Type','Authorization'],
}));
app.use(express.json());

// ── Firebase Admin ────────────────────────────────────────────────────────────
let db = null;
try {
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  }
  db = admin.firestore();
  console.log('✅ Firebase connecté');
} catch (e) {
  console.warn('⚠️  Firebase non configuré — mode mémoire activé');
}

// ── Stockage en mémoire (fallback si Firebase absent) ─────────────────────────
let ordersMemory = [];

// ── Twilio WhatsApp ───────────────────────────────────────────────────────────
let twilioClient = null;
try {
  const twilio = require('twilio');
  twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  console.log('✅ Twilio connecté');
} catch (e) {
  console.warn('⚠️  Twilio non configuré');
}

async function sendWhatsApp(to, message) {
  if (!twilioClient) return;
  try {
    const msg = await twilioClient.messages.create({
      from: process.env.TWILIO_WA_FROM || 'whatsapp:+14155238886',
      to:   to.startsWith('whatsapp:') ? to : `whatsapp:${to}`,
      body: message,
    });
    console.log('📲 WhatsApp envoyé:', msg.sid);
  } catch (e) {
    console.error('❌ Erreur WhatsApp:', e.message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function generateOrderId() {
  return 'SN' + Math.floor(100000 + Math.random() * 900000);
}

async function saveOrder(order) {
  if (db) {
    const ref = await db.collection('commandes').add(order);
    return ref.id;
  } else {
    ordersMemory.unshift(order);
    return order.id;
  }
}

async function getOrders() {
  if (db) {
    const snap = await db.collection('commandes').orderBy('timestamp', 'desc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }
  return ordersMemory;
}

async function updateOrder(id, changes) {
  if (db) {
    await db.collection('commandes').doc(id).update(changes);
  } else {
    const idx = ordersMemory.findIndex(o => o.id === id);
    if (idx > -1) ordersMemory[idx] = { ...ordersMemory[idx], ...changes };
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════════════════════════════

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'OK', app: 'CANASEN API', version: '1.0.0' });
});

// ── GET /api/orders/check-limit/:phone — Vérifier la limite avant soumission ──
app.get('/api/orders/check-limit/:phone', async (req, res) => {
  try {
    const normalizePhone = (phone) => phone.replace(/[\s\-\+\(\)\.]/g, '');
    const clientPhone = normalizePhone(req.params.phone);
    const today = new Date().toLocaleDateString('fr-FR');
    const allOrders = await getOrders();
    const clientOrdersToday = allOrders.filter(o => {
      const orderPhone = normalizePhone(o.client?.telephone || '');
      const orderDate = new Date(o.timestamp).toLocaleDateString('fr-FR');
      return orderPhone === clientPhone && orderDate === today && o.status !== 'Annulé';
    });
    res.json({
      success: true,
      phone: req.params.phone,
      orderCountToday: clientOrdersToday.length,
      limitReached: clientOrdersToday.length >= 3,
      remaining: Math.max(0, 3 - clientOrdersToday.length),
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── GET /api/orders — Récupérer toutes les commandes (admin) ──────────────────
app.get('/api/orders', async (req, res) => {
  try {
    const orders = await getOrders();
    res.json({ success: true, orders });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── POST /api/orders — Créer une nouvelle commande ────────────────────────────
app.post('/api/orders', async (req, res) => {
  try {
    const { type, marque, modele, annee, pieces, options, client, expedition, cart } = req.body;

    // Validation basique
    if (!client?.nom || !client?.telephone || !client?.email || !client?.ville) {
      return res.status(400).json({ success: false, error: 'Champs client obligatoires manquants' });
    }

    // ── Limite de 3 commandes par jour par numéro de téléphone ───────────────
    const normalizePhone = (phone) => phone.replace(/[\s\-\+\(\)\.]/g, '');
    const clientPhone = normalizePhone(client.telephone);

    const allOrders = await getOrders();

    // Filtre uniquement les commandes du jour en cours
    const today = new Date().toLocaleDateString('fr-FR');
    const clientOrdersToday = allOrders.filter(o => {
      const orderPhone = normalizePhone(o.client?.telephone || '');
      const orderDate = new Date(o.timestamp).toLocaleDateString('fr-FR');
      return orderPhone === clientPhone && orderDate === today && o.status !== 'Annulé';
    });

    if (clientOrdersToday.length >= 3) {
      return res.status(429).json({
        success: false,
        limitReached: true,
        error: `Limite de 3 commandes par jour atteinte pour le numéro ${client.telephone}. Réessayez demain ou contactez CANASEN directement au +1 438 928 7856.`,
        existingOrders: clientOrdersToday.length,
      });
    }
    // ─────────────────────────────────────────────────────────────────────────

    const order = {
      id:        generateOrderId(),
      type:      type || 'pieces',
      marque:    marque || '',
      modele:    modele || '',
      annee:     annee || '',
      pieces:    pieces || [],
      options:   options || {},
      client:    client,
      expedition: expedition || 'avion',
      cart:      cart || [],
      status:    'Nouveau',
      note:      '',
      timestamp: new Date().toISOString(),
      date:      new Date().toLocaleString('fr-FR'),
    };

    const savedId = await saveOrder(order);
    order.id = savedId;

    // ── Notification WhatsApp admin ──
    const typeLabel = type === 'voiture' ? '🚗 VÉHICULE' : type === 'produits' ? '🛢️ PRODUITS' : '🔧 PIÈCES';
    const piecesText = pieces?.length ? pieces.slice(0,5).join(', ') + (pieces.length > 5 ? `... (+${pieces.length-5})` : '') : '';

    let waMsg = `🔔 *NOUVELLE COMMANDE ${typeLabel} — CANASEN*\n\n`;
    waMsg += `📋 *N°* ${order.id}\n`;
    waMsg += `🚗 *Véhicule:* ${marque} ${modele} ${annee}\n`;
    if (piecesText) waMsg += `🔧 *Pièces (${pieces.length}):* ${piecesText}\n`;
    if (options?.couleur)      waMsg += `🎨 *Couleur:* ${options.couleur}\n`;
    if (options?.transmission) waMsg += `⚙️ *Transmission:* ${options.transmission}\n`;
    if (options?.cylindree)    waMsg += `🔩 *Cylindrée:* ${options.cylindree}\n`;
    if (options?.carburant)    waMsg += `⛽ *Carburant:* ${options.carburant}\n`;
    if (options?.kilometrage)  waMsg += `🛣️ *Kilométrage max:* ${options.kilometrage}\n`;
    if (cart?.length)          waMsg += `🛒 *Articles:* ${cart.map(i => `${i.qty}x ${i.name}`).join(', ')}\n`;
    waMsg += `\n👤 *Client:* ${client.nom}\n`;
    waMsg += `📞 *Tél:* ${client.telephone}\n`;
    waMsg += `✉️ *Email:* ${client.email}\n`;
    waMsg += `📍 *Ville:* ${client.ville}${client.adresse ? ', ' + client.adresse : ''}\n`;
    if (client.notes) waMsg += `💬 *Notes:* ${client.notes}`;

    await sendWhatsApp(process.env.TWILIO_WA_TO, waMsg);

    res.status(201).json({ success: true, order });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── PATCH /api/orders/:id/status — Changer le statut d'une commande ───────────
app.patch('/api/orders/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['Nouveau','En traitement','Devis envoyé','Confirmé','Expédié','Livré','Annulé'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: 'Statut invalide' });
    }

    await updateOrder(id, { status });
    res.json({ success: true, id, status });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── PATCH /api/orders/:id/note — Ajouter une note interne ────────────────────
app.patch('/api/orders/:id/note', async (req, res) => {
  try {
    const { id } = req.params;
    const { note } = req.body;
    await updateOrder(id, { note });
    res.json({ success: true, id, note });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── POST /api/orders/:id/notify-arrival — Notifier le client à Dakar ──────────
app.post('/api/orders/:id/notify-arrival', async (req, res) => {
  try {
    const { id } = req.params;

    // Récupérer la commande
    let order = null;
    if (db) {
      const doc = await db.collection('commandes').doc(id).get();
      if (doc.exists) order = { id: doc.id, ...doc.data() };
    } else {
      order = ordersMemory.find(o => o.id === id);
    }

    if (!order) {
      return res.status(404).json({ success: false, error: 'Commande introuvable' });
    }

    const expLabel = order.expedition === 'avion' ? 'avion ✈️' : 'bateau 🚢';
    const piecesText = order.pieces?.slice(0,5).join(', ') || '';

    const msg =
      `🎉 *Bonjour ${order.client.nom} !*\n\n` +
      `Votre commande *N° ${order.id}* est arrivée à *Dakar* et est prête à être récupérée ! 📦\n\n` +
      `🚗 *Véhicule :* ${order.marque} ${order.modele} ${order.annee}\n` +
      `🔧 *Pièces :* ${piecesText}\n` +
      `📦 *Expédition :* Par ${expLabel}\n\n` +
      `Contactez-nous pour organiser la livraison finale.\n` +
      `📞 *CANASEN :* +1 438 928 7856\n\n` +
      `Merci de votre confiance ! 🙏`;

    const clientPhone = order.client.telephone.replace(/[\s\-]/g, '');
    await sendWhatsApp(clientPhone, msg);

    // Mettre à jour le statut
    await updateOrder(id, { status: 'Livré' });

    res.json({ success: true, message: 'Notification envoyée au client' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Démarrage ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Serveur CANASEN démarré sur http://localhost:${PORT}`);
});
