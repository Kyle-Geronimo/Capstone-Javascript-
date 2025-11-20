require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 4000;

// --- Configuration Check ---
const requiredEnv = ['GEMINI_API_KEY', 'PAGE_ACCESS_TOKEN', 'VERIFY_TOKEN'];
const missingEnv = requiredEnv.filter(key => !process.env[key]);
if (missingEnv.length > 0) {
  console.error(`❌ Missing required .env variables: ${missingEnv.join(', ')}`);
  process.exit(1);
}

// --- 1. Initialize Firebase Admin (safe single-init) ---
try {
  const serviceAccountPath = path.join(__dirname, 'mariners-hotellink-firebase-adminsdk-fbsvc-65bfc6c5b7.json');
  
  if (!fs.existsSync(serviceAccountPath)) {
    throw new Error(`File not found at: ${serviceAccountPath}`);
  }

  const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));

  // Safe initialize: only initialize once per process
  if (!admin.apps || admin.apps.length === 0) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: process.env.FIREBASE_PROJECT_ID || serviceAccount.project_id
    });
    console.log('✅ Firebase Auth initialized.');
  } else {
    console.log('ℹ️ Firebase already initialized — reusing existing app.');
  }

  // Expose debug info about which key is being used
  console.log('DEBUG: Resolved service account path:', serviceAccountPath);
  console.log('DEBUG: fs.existsSync ->', fs.existsSync(serviceAccountPath));
  console.log('DEBUG: serviceAccount keys:', Object.keys(serviceAccount).join(', '));
  console.log('DEBUG: serviceAccount.project_id:', serviceAccount.project_id);
  console.log('DEBUG: env FIREBASE_PROJECT_ID:', process.env.FIREBASE_PROJECT_ID);

} catch (error) {
  console.error('❌ Error initializing Firebase:', error.message);
  if (error.message.includes('not defined')) {
    console.error("   -> HINT: Check your service-account.json file for missing quotes around a string value.");
  }
  process.exit(1);
}

const db = admin.firestore();

// DO a real read/write diagnostic (after db exists)
(async () => {
  try {
    await db.collection('__diagnostic_test__').doc('ping').set({ ts: admin.firestore.FieldValue.serverTimestamp() });
    const doc = await db.collection('__diagnostic_test__').doc('ping').get();
    console.log('DIAGNOSTIC write/read success:', doc.exists, doc.data());
  } catch (err) {
    console.error('DIAGNOSTIC FAIL (full):', JSON.stringify(err, Object.getOwnPropertyNames(err), 2));
  }
})();

// --- DIAGNOSTIC: Check Connection on Startup ---
async function checkFirestoreConnection() {
  console.log('⏳ Testing Firestore connection...');
  try {
    // List collections to prove we can talk to the DB
    const collections = await db.listCollections();
    const collectionNames = collections.map(c => c.id);

    if (collectionNames.length === 0) {
      console.warn("⚠️  Connected to Firestore, but NO collections found. Did you create 'hotels' and 'chatbot'?");
    } else {
      console.log('✅ Firestore Connected! Found collections:', collectionNames.join(', '));
    }

    // Test Read specifically for 'hotels'
    const hotelTest = await db.collection('hotels').limit(1).get();
    console.log(`   -> 'hotels' collection contains documents? ${!hotelTest.empty}`);

  } catch (error) {
    console.error('❌ FIRESTORE CONNECTION FAILED:');
    console.error(`   Error Code: ${error.code}`);
    console.error(`   Message: ${error.message}`);
    console.error("   -> HINT: Go to Firebase Console > Firestore Database and click 'Create Database' if you haven't yet.");
  }
}

// Run the test immediately
checkFirestoreConnection();


// --- 2. Initialize Gemini ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

// Middleware
app.use(bodyParser.json());


// --- Utility: normalize text ---
function normalizeText(s = '') {
  return s
    .replace(/[^\w\s-]/g, ' ')   // replace punctuation except letters, numbers, spaces, hyphens
    .replace(/\s+/g, ' ')        // collapse multiple spaces
    .trim()
    .toLowerCase();
}

// format number as currency (adjust locale/currency to taste)
function formatCurrency(num) {
  if (typeof num !== 'number' || Number.isNaN(num)) return String(num);
  return new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', maximumFractionDigits: 0 }).format(num);
}

// try to coerce a price-like value to number safely (strip commas, trim)
function parsePrice(raw) {
  if (raw == null) return NaN;
  if (typeof raw === 'number') return raw;
  const s = String(raw).trim().replace(/[, ]+/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

// ---------- DROP-IN PATCH START ----------
// Replace existing findAvailableRooms and findAvailableRoomForHotel with these

// Coerce various possible stored values into a boolean
// SIMPLE: Only rely on the boolean "available" field.
// No status parsing, no regex, no inference.
function coerceAvailable(val) {
  if (val === true) return true;
  if (val === false) return false;

  // String → boolean coercion (optional, safe)
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    if (['true', 'yes', '1'].includes(s)) return true;
    if (['false', 'no', '0'].includes(s)) return false;
  }

  // Number → boolean coercion (optional, safe)
  if (typeof val === 'number') return val === 1;

  // Missing or unknown → treat as unavailable
  return false;
}

// Defensive helper for extracting nights and available fields cleanly
function extractRoomFields(rDoc) {
  const r = rDoc || {};

  // price variants
  const rawPrice = r.price ?? r.rate ?? r.cost ?? null;
  const priceNum = parsePrice(rawPrice);
  const priceStr = Number.isFinite(priceNum)
    ? formatCurrency(priceNum)
    : (rawPrice != null ? String(rawPrice) : 'n/a');

  // room type / number variants
  const roomtype =
    r.roomtype ??
    r.type ??
    r.name ??
    r.roomType ??
    null;

  const roomnumber =
    r.roomnumber ??
    r.number ??
    r.no ??
    null;

  // nights variants
  const nights =
    ('nights' in r) ? r.nights :
    ('nightsCount' in r) ? r.nightsCount :
    ('nights_count' in r) ? r.nights_count :
    null;

  // AVAILABLE: strictly boolean-based (no status)
  const available = coerceAvailable(r.available);

  return {
    roomtype: roomtype || 'room',
    roomnumber,
    nights,
    priceNum: Number.isFinite(priceNum) ? priceNum : null,
    priceStr,
    available,
    _raw: r
  };
}

/**
 * findAvailableRooms(hotelId, options)
 * - Replaces previous function with a boolean-first query and a flexible fallback.
 * - Returns array of rooms with normalized fields: { docId, roomnumber, roomtype, priceNum, priceStr, available }
 */
async function findAvailableRooms(hotelId, { limit = 10, sortBy = 'cheapest' } = {}) {
  try {
    const roomsRef = db.collection('hotels').doc(hotelId).collection('rooms');

    // Fast path: query docs explicitly marked available === true
    let snap;
    try {
      snap = await roomsRef.where('available', '==', true).limit(limit).get();
    } catch (qerr) {
      // Some projects / indexes might reject the where; fall back to read-all
      console.warn('WARN: where("available", "==", true) failed — falling back to local filter. ', qerr.message || qerr);
      snap = null;
    }

    // If fast query returned nothing, or failed, fetch a batch and filter locally
    if (!snap || snap.empty) {
      // read a reasonable batch and filter in code (handles mixed schema)
      const batchSnap = await roomsRef.limit(Math.max(limit, 50)).get();
      if (batchSnap.empty) return [];

      const rooms = batchSnap.docs.map(doc => {
        const r = doc.data() || {};
        const priceNum = parsePrice(r.price ?? r.cost ?? r.rate);
        return {
          docId: doc.id,
          roomnumber: r.roomnumber ?? r.number ?? null,
          roomtype: r.roomtype ?? r.type ?? r.name ?? doc.id,
          nights: (typeof r.nights !== 'undefined') ? r.nights : null,
          priceNum: Number.isFinite(priceNum) ? priceNum : null,
          priceStr: Number.isFinite(priceNum) ? formatCurrency(priceNum) : (r.price != null ? String(r.price) : 'n/a'),
          available: coerceAvailable(r.available),
          // include status string for extra heuristics
          _statusRaw: (r.status || r.roomstatus || '').toString().toLowerCase()
        };
      });

      // Filter: keep if available boolean true OR if boolean missing but status not occupied
      const filtered = rooms.filter(r => {
        if (r.available) return true;
        // if available not present, use status heuristic
        if (typeof r.available === 'boolean' && r.available === false) return false;
        const isOccupied = /occupied|booked|in[- ]use|unavailable/.test(r._statusRaw);
        return !isOccupied;
      });

      // sort if requested
      if (sortBy === 'cheapest') {
        filtered.sort((a,b) => {
          if (a.priceNum == null) return 1;
          if (b.priceNum == null) return -1;
          return a.priceNum - b.priceNum;
        });
      }

      // return up to limit
      return filtered.slice(0, limit).map(({ _statusRaw, ...keep }) => keep);
    }

    // If we reached here, snap exists and contains only docs where available === true
    const rooms = snap.docs.map(doc => {
      const r = doc.data() || {};
      const priceNum = parsePrice(r.price ?? r.cost ?? r.rate);
      return {
        docId: doc.id,
        roomnumber: r.roomnumber ?? r.number ?? null,
        roomtype: r.roomtype ?? r.type ?? r.name ?? doc.id,
        nights: (typeof r.nights !== 'undefined') ? r.nights : null,
        priceNum: Number.isFinite(priceNum) ? priceNum : null,
        priceStr: Number.isFinite(priceNum) ? formatCurrency(priceNum) : (r.price != null ? String(r.price) : 'n/a'),
        available: true
      };
    });

    if (sortBy === 'cheapest') {
      rooms.sort((a,b) => {
        if (a.priceNum == null) return 1;
        if (b.priceNum == null) return -1;
        return a.priceNum - b.priceNum;
      });
    }

    return rooms.slice(0, limit);
  } catch (err) {
    console.warn('⚠️ findAvailableRooms error:', err.message || err);
    return [];
  }
}

/**
 * findAvailableRoomForHotel(hotelId, preferredType = null, maxScan = 100)
 * - Returns a single available room object { roomnum, roomtype, priceStr, rawPrice } or null.
 * - Prefer rooms matching preferredType when possible.
 */
async function findAvailableRoomForHotel(hotelId, preferredType = null, maxScan = 100) {
  try {
    const roomsRef = db.collection('hotels').doc(hotelId).collection('rooms');

    // Try a targeted query first (available === true)
    try {
      const qSnap = await roomsRef.where('available', '==', true).limit(maxScan).get();
      if (!qSnap.empty) {
        // convert docs, try to pick preferred type
        const docs = qSnap.docs.map(rd => {
          const r = rd.data() || {};
          const rawPrice = r.price ?? r.cost ?? r.rate;
          const priceNum = parsePrice(rawPrice);
          return {
            roomnum: r.roomnumber ?? r.number ?? rd.id,
            roomtype: r.roomtype ?? r.type ?? r.name ?? '',
            priceNum,
            priceStr: Number.isFinite(priceNum) ? formatCurrency(priceNum) : (rawPrice != null ? String(rawPrice) : 'n/a')
          };
        });

        const pref = (preferredType || '').toLowerCase();
        if (pref) {
          const found = docs.find(d => (d.roomtype || '').toLowerCase().includes(pref));
          if (found) return found;
        }
        // otherwise return first (cheapest logic optional)
        docs.sort((a,b) => {
          if (a.priceNum == null) return 1;
          if (b.priceNum == null) return -1;
          return a.priceNum - b.priceNum;
        });
        return docs[0] || null;
      }
    } catch (qerr) {
      console.warn('WARN: where("available", "==", true) query failed in findAvailableRoomForHotel — will fallback. ', qerr.message || qerr);
      // fallthrough to flexible scan
    }

    // Flexible fallback: read up to maxScan docs and evaluate locally
    const snap = await roomsRef.limit(maxScan).get();
    if (snap.empty) return null;

    const preferred = (preferredType || '').toLowerCase();
    const available = [];
    const preferredMatches = [];

    for (const rd of snap.docs) {
      const r = rd.data() || {};
      const rawPrice = r.price ?? r.cost ?? r.rate;
      const priceNum = parsePrice(rawPrice);
      const status = (r.status || r.roomstatus || '').toString().toLowerCase();
      const isOccupied = /occupied|booked|in[- ]use|unavailable/.test(status);

      const isAvail = coerceAvailable(r.available);
      // treat as available if boolean true OR boolean missing and status not occupied
      if (!isAvail && ('available' in r) && isAvail === false) continue; // explicitly unavailable
      if (!isAvail && !('available' in r) && isOccupied) continue;

      const roomnum = r.roomnumber ?? r.number ?? rd.id;
      const roomtype = (r.roomtype || r.type || r.name || '').toString();
      const entry = { roomnum: String(roomnum), roomtype, priceStr: !Number.isNaN(priceNum) ? formatCurrency(priceNum) : (rawPrice != null ? String(rawPrice) : 'n/a'), rawPrice };

      if (preferred && roomtype.toLowerCase().includes(preferred)) {
        preferredMatches.push(entry);
      } else {
        available.push(entry);
      }
    }

    if (preferredMatches.length > 0) return preferredMatches[0];
    if (available.length > 0) return available[0];
    return null;
  } catch (err) {
    console.warn('⚠️ findAvailableRoomForHotel error:', err.message || err);
    return null;
  }
}
// ---------- DROP-IN PATCH END ----------


// Try to answer price queries deterministically from shortCtx Rooms string.
// shortCtx expected to contain a "Rooms: ..." part like:
// "Rooms: standard: 1 nights — ₱1,500; deluxe: 2 nights — ₱3,000"
function extractPriceAnswerFromShortCtx(userMessage, shortCtx) {
  if (!shortCtx || !shortCtx.includes('Rooms:')) return null;
  // isolate rooms substring (stop at next " | " if present)
  const roomsStart = shortCtx.indexOf('Rooms:');
  let roomsSub = shortCtx.slice(roomsStart + 'Rooms:'.length).trim();
  // if there are other ' | ' parts after Rooms:, cut them off
  const nextPipe = roomsSub.indexOf(' | ');
  if (nextPipe !== -1) roomsSub = roomsSub.slice(0, nextPipe).trim();

  // split entries separated by semicolons
  const entries = roomsSub.split(';').map(s => s.trim()).filter(Boolean);
  // parse entries into objects {type, nights, priceStr}
  const parsed = entries.map(entry => {
    // expected forms:
    // "standard (1 nights) — ₱1,500"
    // "standard: 1 nights — ₱1,500"
    // "standard: 1 nights — 1500"
    // Normalize different separators
    // Find price portion after em dash '—' or hyphen '-' or ' - '
    let type = null, nights = null, priceStr = null;
    const emDashMatch = entry.match(/—\s*(.+)$/); // em dash
    const hyphenMatch = !emDashMatch && entry.match(/-\s*(.+)$/);
    const pricePart = emDashMatch ? emDashMatch[1] : (hyphenMatch ? hyphenMatch[1] : null);

    // price string
    priceStr = pricePart ? pricePart.trim() : null;

    // take left side (before '—' or '-') and extract type and nights
    const left = pricePart ? entry.slice(0, entry.indexOf(pricePart)).trim() : entry;
    // remove trailing separators like ":" or "—"
    const leftClean = left.replace(/[:—-]$/, '').trim();

    // try to get type (before first '(' or ':')
    const typeMatch = leftClean.match(/^([^:(]+)(?:[:(].*)?$/);
    type = typeMatch ? typeMatch[1].trim() : leftClean;

    // extract nights like "(1 nights)" or "1 nights"
    const nightsMatch = leftClean.match(/(\d+)\s*nights?/i) || leftClean.match(/\((\d+)\s*nights?\)/i);
    nights = nightsMatch ? `${nightsMatch[1]} night${nightsMatch[1] === '1' ? '' : 's'}` : null;

    return { type: type.toLowerCase(), displayType: type, nights, priceStr };
  });

  // normalize user query to find a requested type word
  const q = normalizeText(userMessage || '');

  // soft room-type matching: tokens vs tokens
const qTokens = q.split(" ").filter(Boolean);

for (const p of parsed) {
  const typeTokens = p.type.split(" ").filter(Boolean);

  // any overlapping token counts as match
  const overlap = qTokens.some(token => typeTokens.some(tt => tt.includes(token) || token.includes(tt)));
  if (overlap) {
    matchedEntry = p;
    break;
  }
}

  // if not found, search tokens in query for an entry
  if (!matchedEntry) {
    const tokens = q.split(' ');
    for (const token of tokens) {
      if (!token) continue;
      const found = parsed.find(p => p.type.includes(token) || token.includes(p.type));
      if (found) { matchedEntry = found; break; }
    }
  }

  // If still not found, but user clearly asked "price" or "how much", return a summary list
  const isPriceQuestion = /\b(price|cost|how much|rate|how much is|how much are)\b/i.test(userMessage || '');
  if (matchedEntry) {
    // return a concise sentence
    const nightsText = matchedEntry.nights ? ` (${matchedEntry.nights})` : '';
    return `${matchedEntry.displayType}: ${matchedEntry.priceStr}${nightsText}`;
  } else if (isPriceQuestion) {
    // summarize all types and prices
    if (parsed.length === 0) return null;
    const summary = parsed.map(p => `${p.displayType}: ${p.priceStr}${p.nights ? ` (${p.nights})` : ''}`).join('; ');
    return `Available room prices: ${summary}`;
  }

  // Not a price question or couldn't extract
  return null;
}

// --- Helper: Simple fuzzy-ish name-based retrieval (less strict) ---
async function findDocByName(query) {
  const q = normalizeText(query || '');
  if (!q) return null;

  const tokens = q.split(" ").filter(Boolean);  // e.g. “mariners bicotel main” → ["mariners","bicotel","main"]

  const snapshot = await db.collection('hotels').get();

  let bestMatch = null;
  let bestScore = 0;

  for (const doc of snapshot.docs) {
    const d = doc.data() || {};
    const hotelId = doc.id.toLowerCase();
    const name = (d.name || "").toLowerCase();
    const aliases = (d.aliases || []).map(a => (a || "").toLowerCase());
    const loc = (d.location || "").toLowerCase();

    const haystack = [hotelId, name, loc, ...aliases].join(" ");

    // score how many tokens appear
    let score = 0;
    for (const t of tokens) {
      if (t.length < 2) continue;
      if (haystack.includes(t)) score++;
    }

    // fallback: entire query substring check
    if (haystack.includes(q)) score += 2;

    // keep best-scoring hotel
    if (score > bestScore) {
      bestScore = score;
      bestMatch = { id: doc.id, data: d };
    }
  }

  // require at least SOME match
  if (bestScore >= 1) return bestMatch;

  return null;
}


// --- Helper: Fetch Context from Safe Collections ---
async function getKnowledgeBase() {
  try {
    const lines = [];
    let docCount = 0;
    const FAQ_LIMIT = 25; 
    const ROOM_LIMIT = 20; 

    console.log('🔍 Fetching Knowledge Base (including hotel subcollection FAQs and rooms)...');

    // 1. Fetch Hotel Data
    const hotelsSnapshot = await db.collection('hotels').get();
    if (!hotelsSnapshot.empty) {
      for (const hotelDoc of hotelsSnapshot.docs) {
        docCount++;
        const d = hotelDoc.data() || {};
        const hotelId = hotelDoc.id;

        // --- A. Fetch Rooms Subcollection ---
        let roomsText = '';
        try {
          const roomsSnap = await db.collection('hotels').doc(hotelId).collection('rooms').limit(ROOM_LIMIT).get();
          if (!roomsSnap.empty) {
            const roomLines = [];
            for (const roomDoc of roomsSnap.docs) {
              const r = roomDoc.data() || {};
              // Price parsing
              const rawPrice = r.price ?? r.cost ?? r.rate;
              const priceNum = parsePrice(rawPrice);
              const priceStr = !Number.isNaN(priceNum) ? formatCurrency(priceNum) : (rawPrice != null ? String(rawPrice) : 'n/a');
              
              // Data extraction
              const type = r.roomtype ?? r.type ?? r.name ?? roomDoc.id;
              const nights = (typeof r.nights !== 'undefined') ? String(r.nights) : 'n/a';
              const avail = r.available ? 'Available' : 'Occupied'; // Optional: indicate status in text
              
              roomLines.push(`${type} (${nights} nights) — ${priceStr} [${avail}]`);
            }
            roomsText = roomLines.join('; ');
          }
          


        } catch (err) {
          console.warn(`⚠️ Could not load rooms for hotel ${hotelId}:`, err.message);
        }

        // --- B. Build Hotel Record ---
        const hotelRecordParts = [
          `DOC_ID:${hotelId}`,
          d.name ? `Name: ${d.name}` : null,
          d.aliases ? `Aliases: ${JSON.stringify(d.aliases)}` : null,
          d.location ? `Location: ${d.location}` : null,
          d.description ? `Description: ${d.description}` : null,
          roomsText ? `Rooms: ${roomsText}` : null,
          d.availability ? `Availability: ${JSON.stringify(d.availability)}` : null
        ].filter(Boolean);
        lines.push(hotelRecordParts.join(' | '));

        // --- C. Fetch Hotel FAQs ---
        try {
          const faqsRef = db.collection('hotels').doc(hotelId).collection('faqs');
          const faqSnapshot = await faqsRef.limit(FAQ_LIMIT).get();
          if (!faqSnapshot.empty) {
            for (const faqDoc of faqSnapshot.docs) {
              const f = faqDoc.data() || {};
              const q = (f.question || f.q || f.prompt || '').toString().trim();
              const a = (f.answer || f.a || f.response || f.reply || '').toString().trim();
              if (q || a) {
                lines.push(`HOTEL_FAQ:${hotelId}:${faqDoc.id} | Q: ${q} | A: ${a}`);
                docCount++;
              }
            }
          }
        } catch (err) {
          console.warn(`⚠️ Could not load FAQs for hotel ${hotelId}:`, err.message);
        }
      }
    } else {
      console.warn("⚠️ 'hotels' collection is empty or missing.");
    }

    // 2. Fetch General Chatbot FAQs
    const chatbotSnapshot = await db.collection('chatbot').get();
    if (!chatbotSnapshot.empty) {
      chatbotSnapshot.forEach(doc => {
        docCount++;
        const d = doc.data() || {};
        const q = d.question || d.q || '';
        const a = d.answer || d.a || d.response || '';
        lines.push(`FAQ_ID:${doc.id} | Q: ${q} | A: ${a}`);
      });
    }

    console.log(`✅ Loaded ${docCount} documents/records for context.`);
    if (lines.length === 0) return 'No information available.';
    return lines.join('\n\n');
  } catch (error) {
    console.error('❌ Error fetching Firestore data:', error);
    return '';
  }
}


// --- Helper: Send Message to Facebook Messenger ---
async function sendMessengerReply(senderPsid, responseText) {
  const requestBody = {
    recipient: { id: senderPsid },
    message: { text: responseText }
  };

  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/me/messages?access_token=${process.env.PAGE_ACCESS_TOKEN}`,
      requestBody
    );
    console.log(`📤 Reply sent to ${senderPsid}`);
  } catch (error) {
    console.error('❌ Error sending message to Facebook:', error.response ? error.response.data : error.message);
  }
}

// --- Helper: Save Log to Firebase ---
async function logConversation(userId, userMessage, botResponse) {
  try {
    await db.collection('customer_queries').add({
      userId: userId,
      query: userMessage,
      response: botResponse,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log('📝 Conversation logged to Firestore.');
  } catch (error) {
    console.error('❌ Error logging conversation:', error.message);
  }
}

// --- Save user question into the 'chatbot' collection (with category + timestamp) ---
// Usage: await saveUserQuestion(userMessage);
async function saveUserQuestion(questionText) {
  if (!questionText || !questionText.trim()) return null;
  const qTrim = questionText.trim();

  try {
    // 1) Avoid exact-duplicate entries (optional)
    const dup = await db.collection('chatbot').where('question', '==', qTrim).limit(1).get();
    if (!dup.empty) {
      console.log('INFO: question already exists in chatbot collection; skipping insert.');
      return { skipped: true };
    }

    // 2) Categorize the question (try model classifier, fall back to rule-based)
    const category = (await categorizeQuestion(qTrim)) || 'general';

    // 3) Write to Firestore
    const docRef = await db.collection('chatbot').add({
      category,
      question: qTrim,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log('✅ Saved user question to chatbot collection. id=', docRef.id, 'category=', category);
    return { id: docRef.id, category };
  } catch (err) {
    console.error('❌ Failed to save user question:', err.message || err);
    return null;
  }
}

// --- Categorize question: try model first, fallback to rules ---
async function categorizeQuestion(questionText) {
  // fast rule-based fallback
  function ruleCategory(q) {
    const s = q.toLowerCase();
    if (/\b(price|cost|rate|how much|fee|charge)\b/.test(s)) return 'pricing';
    if (/\b(available|availability|vacancy|vacancies|full|booked|occupied)\b/.test(s)) return 'availability';
    if (/\b(book|reservation|reserve|booking|cancel|change reservation)\b/.test(s)) return 'booking';
    if (/\b(pool|gym|wifi|amenit|breakfast|parking|pet)\b/.test(s)) return 'amenities';
    if (/\b(check-in|check out|checkin|checkout|policy|policies|cancellation)\b/.test(s)) return 'policies';
    if (/\b(direction|how to get|where is|location|near)\b/.test(s)) return 'directions';
    if (/\b(menu|food|restaurant|dinner|breakfast|bar)\b/.test(s)) return 'food';
    return 'general';
  }

  // Try the model first (keeps categories small and predictable)
  try {
    const classifierPrompt = `
Classify the following user question into one of these categories (single word, return ONLY the category): 
pricing, availability, booking, amenities, policies, directions, food, general, other.

Question:
\"\"\"${questionText}\"\"\"
`;
    const result = await model.generateContent(classifierPrompt);
    const response = await result.response;
    let cat = response.text && response.text().trim ? response.text().trim() : (response?.output?.text ?? '');
    if (!cat) throw new Error('empty model classification');

    // Some models return sentences; take the first token/word and normalize
    cat = cat.split(/\s|[,:;\n]/)[0].toLowerCase();
    // validate category is one we expect
    const allowed = new Set(['pricing','availability','booking','amenities','policies','directions','food','general','other']);
    if (allowed.has(cat)) return cat;

    // If model returned an unexpected token, fall back to rule-based
    return ruleCategory(questionText);
  } catch (err) {
    // model error -> fallback
    console.warn('WARN: model classification failed, using rule-based fallback:', err.message || err);
    return ruleCategory(questionText);
  }
}

// --- ROUTES ---

// 1. Facebook Webhook Verification (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
      console.log('✅ Webhook Verified');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

// 2. Facebook Message Handler (POST)
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object === 'page') {
    res.status(200).send('EVENT_RECEIVED');

    for (const entry of body.entry) {
      if (entry.messaging) {
        const webhookEvent = entry.messaging[0];

        if (webhookEvent.message && webhookEvent.message.text) {
          const senderPsid = webhookEvent.sender.id;
          const userMessage = webhookEvent.message.text;

          console.log(`📩 Received from ${senderPsid}: ${userMessage}`);

          // right after you compute userMessage
console.log(`📩 Received from ${senderPsid}: ${userMessage}`);

// Save the user question into chatbot collection (non-blocking but awaited for reliability)
try {
  await saveUserQuestion(userMessage);
} catch (err) {
  console.warn('WARN: failed to save user question (non-fatal):', err.message || err);
}

// continue with your existing flow...


          // A. Try targeted lookup first
          const matched = await findDocByName(userMessage);
          let prompt;

          if (matched) {
            const d = matched.data || {};

            // fetch rooms subcollection for matched hotel and format prices
            let rooms = '';
let calculationNote = ''; // <--- 1. CREATE THIS VARIABLE
try {
  const roomsSnap = await db.collection('hotels').doc(matched.id).collection('rooms').get();
  
  if (!roomsSnap.empty) {
    // [EXISTING CODE] Your existing room string builder
    const roomLines = roomsSnap.docs.map(rd => {
  const info = extractRoomFields(rd.data() || {});
  const nightsText = info.nights != null ? ` (${info.nights} nights)` : '';
  const availText = info.available ? 'Available' : 'Unavailable';
  return `${info.roomtype}${nightsText} — ${info.priceStr} [${availText}]`;
});
rooms = roomLines.join('; ');


    // --- START NEW CODE: CALCULATOR INJECTION ---
    
    // 2. Detect if user mentioned "X nights" using Regex
    const nightMatch = userMessage.match(/(\d+)\s*nights?/i);
    
    if (nightMatch) {
      const nightsCount = parseInt(nightMatch[1], 10);
      
      // 3. Calculate total for ALL rooms found
      const calculations = roomsSnap.docs.map(rd => {
        const r = rd.data() || {};
        const price = parsePrice(r.price ?? r.cost ?? r.rate);
        const type = r.roomtype || r.type || r.name || "Standard";

        if (Number.isFinite(price)) {
          const total = price * nightsCount;
          return `${type} Room: ${formatCurrency(total)} (for ${nightsCount} nights)`;
        }
        return null;
      }).filter(Boolean);

      // 4. Create a strong instruction for Gemini
      if (calculations.length > 0) {
        calculationNote = `
*** SYSTEM CALCULATION NOTE ***
The user asked for ${nightsCount} nights. I have calculated the totals for you. 
DO NOT do the math yourself. Use these exact figures:
${calculations.join('\n')}
`;
      }
    }
              }
            } catch (err) {
              console.warn('⚠️ Could not fetch rooms for matched hotel:', err.message);
            }

            const shortCtxParts = [
              `DOC_ID:${matched.id}`,
              d.name ? `Name: ${d.name}` : null,
              d.location ? `Location: ${d.location}` : null,
              d.description ? `Description: ${d.description}` : null,
              rooms ? `Rooms: ${rooms}` : null,
              d.availability ? `Availability: ${JSON.stringify(d.availability)}` : null,
              calculationNote ? calculationNote : null
            ].filter(Boolean);
            let shortCtx = shortCtxParts.join(' | ');

            // fetch FAQs for matched hotel (small limit)
            try {
              const faqRef = db.collection('hotels').doc(matched.id).collection('faqs');
              const faqSnap = await faqRef.limit(15).get();
              if (!faqSnap.empty) {
                const faqLines = [];
                for (const faqDoc of faqSnap.docs) {
                  const f = faqDoc.data() || {};
                  const q = (f.question || f.q || '').toString().trim();
                  const a = (f.answer || f.a || '').toString().trim();
                  if (q || a) faqLines.push(`HOTEL_FAQ:${matched.id}:${faqDoc.id} | Q: ${q} | A: ${a}`);
                }
                if (faqLines.length) {
                  shortCtx += '\n\n' + faqLines.join('\n');
                }
              }
            } catch (err) {
              console.warn('⚠️ Could not fetch matched hotel FAQs:', err.message);
            }

            prompt = `
You are a helpful hotel assistant. Use the context if it contains relevant facts.
If the context has partial information, make a best-effort helpful answer.
If price or roomtype is mentioned in context, extract and present it clearly.
If something is not explicitly stated, it's okay to say "I don't have that detail, but here's what I can confirm."
Always prioritize being helpful over being strict.

CONTEXT:
${shortCtx}

QUESTION:
${userMessage}
            `.trim();

            console.log('DEBUG: Using targeted context:', shortCtx);
          } else {
            // fallback to full knowledge base (but limit size)
            let knowledgeBase = await getKnowledgeBase();
            console.log('DEBUG: Full knowledge base length:', (knowledgeBase || '').length);
            const MAX_CHARS = 15000;
            if (knowledgeBase.length > MAX_CHARS) {
              console.warn('⚠️ Knowledge base is large; truncating to fit prompt.');
              knowledgeBase = knowledgeBase.slice(0, MAX_CHARS) + '\n\n[TRUNCATED]';
            }

            prompt = `
You are a helpful hotel reservation assistant for Mariners Hotel. Use ONLY the CONTEXT INFORMATION below to answer the user's question.
If the exact fact is not in the context, say "I don't have that information in my context."

CONTEXT INFORMATION:
${knowledgeBase || "No information available."}

USER QUESTION:
${userMessage}
            `.trim();

            console.log('DEBUG: Using full context (truncated):', knowledgeBase ? knowledgeBase.slice(0, 1000) : knowledgeBase);
          }

          try {
            // C. Generate Answer
            console.log('DEBUG: Prompt length', prompt.length);
            const result = await model.generateContent(prompt);
            const response = await result.response;
            let botReply = (response && typeof response.text === 'function') ? response.text() : (response?.output?.text ?? '');
            botReply = (botReply || '').trim();

            // Defensive fallback
            if (!botReply) {
              console.warn('⚠️ Model returned empty response. Sending fallback message.');
              botReply = "I'm sorry, I couldn't find the information you requested in my context. Could you clarify the hotel name or ask about something else?";
            }

            // D. Send Reply
            await sendMessengerReply(senderPsid, botReply);

            // E. Log
            await logConversation(senderPsid, userMessage, botReply + "\n\n[CONTEXT TRUNCATED FOR LOGGING]");

          } catch (error) {
            console.error('Error in AI processing:', error);
            await sendMessengerReply(senderPsid, "I'm having trouble connecting right now. Please try again later.");
          }
        }
      }
    }
  } else {
    res.sendStatus(404);
  }
});


// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n---------------------------------------');
  console.log(`🚀 Server running locally on Port ${PORT}`);
  console.log('⚠️  To test with Messenger, ensure Ngrok is running!');
  console.log('---------------------------------------\n');
});
