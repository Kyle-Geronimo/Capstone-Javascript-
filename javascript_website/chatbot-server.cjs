require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = process.env.CPORT || 4000;

// --- Configuration Check ---
const requiredEnv = ['GEMINI_API_KEY', 'PAGE_ACCESS_TOKEN', 'VERIFY_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_PROJECT_ID'];
const missingEnv = requiredEnv.filter(key => !process.env[key]);
if (missingEnv.length > 0) {
  console.error(`❌ Missing required .env variables: ${missingEnv.join(', ')}`);
  process.exit(1);
}

// --- 1. Initialize Firebase Admin (safe single-init) ---
try {
  const serviceAccountPath = path.resolve(__dirname, process.env.GOOGLE_APPLICATION_CREDENTIALS);

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

// =============================================================================
// RESTRICTED FIRESTORE WRAPPER
// =============================================================================
// This wrapper restricts the Admin SDK to only access allowed collections,
// even though the Admin SDK normally bypasses security rules.
// =============================================================================

const ALLOWED_COLLECTIONS = [
  'hotels',              // Hotel information and FAQs
  'chatbot',             // Chatbot FAQs and saved questions
  'guestReservations',   // Reservation data (for availability checks)
  'customer_queries',    // Conversation logs
  '__diagnostic_test__'  // Diagnostic collection for testing
];

class RestrictedFirestore {
  constructor(firestore, allowedCollections) {
    this._db = firestore;
    this._allowedCollections = new Set(allowedCollections);
    console.log('🔒 RestrictedFirestore initialized. Allowed collections:', [...this._allowedCollections].join(', '));
  }

  /**
   * Validates that a collection name is in the allowlist
   * @param {string} collectionPath - The collection path to validate
   * @throws {Error} If the collection is not allowed
   */
  _validateCollection(collectionPath) {
    // Extract the root collection name (first segment of the path)
    const rootCollection = collectionPath.split('/')[0];
    
    if (!this._allowedCollections.has(rootCollection)) {
      const error = new Error(`🚫 ACCESS DENIED: Collection "${rootCollection}" is not in the allowlist. Allowed: [${[...this._allowedCollections].join(', ')}]`);
      console.error(error.message);
      throw error;
    }
  }

  /**
   * Get a collection reference (with validation)
   * @param {string} collectionPath - Path to the collection
   * @returns {FirebaseFirestore.CollectionReference}
   */
  collection(collectionPath) {
    this._validateCollection(collectionPath);
    return this._db.collection(collectionPath);
  }

  /**
   * List all collections (filtered to only show allowed ones)
   * @returns {Promise<FirebaseFirestore.CollectionReference[]>}
   */
  async listCollections() {
    const allCollections = await this._db.listCollections();
    return allCollections.filter(col => this._allowedCollections.has(col.id));
  }

  /**
   * Run a transaction (passes through to underlying db)
   * Note: Operations within the transaction should use restrictedDb
   */
  runTransaction(updateFunction) {
    return this._db.runTransaction(updateFunction);
  }

  /**
   * Create a batch (passes through to underlying db)
   */
  batch() {
    return this._db.batch();
  }

  /**
   * Get the underlying Firestore instance (use with caution!)
   * This bypasses the restriction - only use for operations that don't involve collections
   */
  get _rawDb() {
    console.warn('⚠️ WARNING: Accessing raw Firestore instance bypasses collection restrictions!');
    return this._db;
  }

  /**
   * Add a collection to the allowlist at runtime
   * @param {string} collectionName - Collection name to add
   */
  allowCollection(collectionName) {
    this._allowedCollections.add(collectionName);
    console.log(`🔓 Collection "${collectionName}" added to allowlist.`);
  }

  /**
   * Remove a collection from the allowlist at runtime
   * @param {string} collectionName - Collection name to remove
   */
  denyCollection(collectionName) {
    this._allowedCollections.delete(collectionName);
    console.log(`🔒 Collection "${collectionName}" removed from allowlist.`);
  }

  /**
   * Check if a collection is allowed
   * @param {string} collectionName - Collection name to check
   * @returns {boolean}
   */
  isCollectionAllowed(collectionName) {
    const rootCollection = collectionName.split('/')[0];
    return this._allowedCollections.has(rootCollection);
  }

  /**
   * Get the list of allowed collections
   * @returns {string[]}
   */
  getAllowedCollections() {
    return [...this._allowedCollections];
  }
}

// Create the raw Firestore instance
const rawDb = admin.firestore();

// Create the restricted wrapper - USE THIS THROUGHOUT THE APP
const db = new RestrictedFirestore(rawDb, ALLOWED_COLLECTIONS);

// =============================================================================
// END RESTRICTED FIRESTORE WRAPPER
// =============================================================================

const HOTEL_ROOM_INVENTORY = {
  "D'Mariners Inn Hotel": Array.from({ length: 25 }, (_, i) => String(i + 1)), // Rooms 1-25
  "Wennrod Hotel": Array.from({ length: 25 }, (_, i) => String(i + 1)), // Rooms 1-25
  "Bicotels Hotel": Array.from({ length: 25 }, (_, i) => String(i + 1)) // Rooms 1-25
};

const HOTEL_NAME_ALIASES = {
  "D'Mariners Inn Hotel": ["mariners", "mariner", "d'mariners", "dmariners", "mariners inn"],
  "Wennrod Hotel": ["wennrod", "wenrod", "wennrod hotel"],
  "Bicotels Hotel": ["bicotels", "bicotel", "bicotels hotel"]
};

function getHotelRoomInventory(hotelName) {
  return HOTEL_ROOM_INVENTORY[hotelName] || [];
}

// Match hotel name from user input (fuzzy matching)
function matchHotelName(userInput) {
  const normalized = userInput.toLowerCase();
  
  for (const [officialName, aliases] of Object.entries(HOTEL_NAME_ALIASES)) {
    // Check if official name is in the input
    if (normalized.includes(officialName.toLowerCase())) {
      return officialName;
    }
    
    // Check aliases
    for (const alias of aliases) {
      if (normalized.includes(alias.toLowerCase())) {
        return officialName;
      }
    }
  }
  
  return null;
}

// Helper to check if a room number is valid for the hotel
function isValidRoomNumber(hotelName, roomNumber) {
  const inventory = HOTEL_ROOM_INVENTORY[hotelName];
  if (!inventory) return false;
  return inventory.includes(String(roomNumber));
}

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
  console.log('⏳ Testing Firestore connection.');
  try {
    // List collections to prove we can talk to the DB (only shows allowed collections)
    const collections = await db.listCollections();
    const collectionNames = collections.map(c => c.id);

    if (collectionNames.length === 0) {
      console.warn("⚠️  Connected to Firestore, but NO allowed collections found. Did you create 'hotels' and 'chatbot'?");
    } else {
      console.log('✅ Firestore Connected! Found allowed collections:', collectionNames.join(', '));
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
app.use(cors({ origin: true }));
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

// Coerce various possible stored values into a boolean
function coerceAvailable(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', 'yes', '1', 'available', 'y', 'ok'].includes(s)) return true;
    if (['false', 'no', '0', 'occupied', 'booked', 'unavailable', 'n'].includes(s)) return false;
  }
  if (typeof v === 'number') return v === 1;
  return undefined; // unknown
}

/**
 * Normalize a Date or 'YYYY-MM-DD' string to a Date representing midnight UTC for comparisons.
 */
function normalizeDateToUTC(dateInput) {
  let d;
  if (!dateInput) d = new Date();
  else if (typeof dateInput === 'string') {
    // Accept '2025-09-15' or ISO strings
    const parts = dateInput.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (parts) {
      d = new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]), 0, 0, 0));
    } else {
      d = new Date(dateInput);
    }
  } else if (dateInput instanceof Date) {
    d = new Date(dateInput);
  } else {
    d = new Date();
  }
  // Normalize to UTC midnight
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0));
}

// Try to parse a Firestore Timestamp or JS date-like into a Date
function toDateSafe(tsOrDate) {
  if (!tsOrDate) return null;
  if (typeof tsOrDate.toDate === 'function') return tsOrDate.toDate();
  const d = new Date(tsOrDate);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * getOccupiedRoomsForDate(hotelNameOrId, targetDate)
 * - hotelNameOrId: the string stored in guestReservations.hotel
 * - targetDate: 'YYYY-MM-DD' or Date
 * Returns: Set of room identifiers (strings) that are occupied for that hotel on that date
 * PRIVACY: Only reads checkIn, checkOut, hotel, room, status fields
 */
async function getOccupiedRoomsForDate(hotelNameOrId, targetDate) {
  const target = normalizeDateToUTC(targetDate);
  const occupied = new Set();

  // Statuses that indicate the room is NOT occupied (guest has left or booking was cancelled)
  const NON_OCCUPIED_STATUSES = [
    'checked-out',
    'checkedout',
    'checked out',
    'cancelled',
    'canceled',
    'no-show',
    'noshow',
    'no show'
  ];

  try {
    const snap = await db.collection('guestReservations')
      .where('hotel', '==', hotelNameOrId)
      .limit(2000)
      .get();

    if (!snap.empty) {
      for (const doc of snap.docs) {
        const r = doc.data() || {};
        if (!r.room || !r.checkIn || !r.checkOut) continue;
        
        const roomNo = String(r.room);
        
        // CRITICAL: Only consider valid room numbers
        if (!isValidRoomNumber(hotelNameOrId, roomNo)) {
          continue;
        }

        // SKIP reservations that are checked-out, cancelled, or no-show
        const status = (r.status || '').toString().toLowerCase().trim();
        if (NON_OCCUPIED_STATUSES.includes(status)) {
          continue;
        }

        const ci = toDateSafe(r.checkIn);
        const co = toDateSafe(r.checkOut);
        if (!ci || !co) continue;

        const ciDay = normalizeDateToUTC(ci);
        const coDay = normalizeDateToUTC(co);

        // Check if target date falls within reservation
        if (ciDay <= target && target < coDay) {
          occupied.add(roomNo);
        }
      }
    }
  } catch (err) {
    console.error('ERROR reading occupancy:', err.message || err);
  }

  return occupied;
}

/**
 * inferRoomsFromReservations(hotelNameOrId)
 * - Scans guestReservations for the given hotel and returns a Map keyed by room number
 * - PRIVACY: Only reads room, checkIn, checkOut fields; never accesses guestName or other PII
 * Returns: { roomNumberStr => { roomnumber, roomtype, lastSeenAt (Date), samplePriceNum, samplePriceStr } }
 */
async function inferRoomsFromReservations(hotelNameOrId, cap = 2000) {
  const roomsMap = new Map();
  
  // Start with the defined room inventory (rooms 1-25)
  const inventory = HOTEL_ROOM_INVENTORY[hotelNameOrId] || [];
  
  if (inventory.length === 0) {
    console.warn(`⚠️ No room inventory defined for hotel: ${hotelNameOrId}`);
    return roomsMap;
  }
  
  console.log(`📋 Hotel "${hotelNameOrId}" inventory: rooms 1-${inventory.length}`);
  
  // Initialize all rooms with basic defaults
  for (const roomNo of inventory) {
    roomsMap.set(roomNo, {
      roomnumber: roomNo,
      roomtype: null, // Will be populated from guestReservations if available
      lastSeenAt: null,
      samplePriceNum: null,
      samplePriceStr: null
    });
  }
  
  // Enhance ONLY with data from guestReservations (no placeholder data)
  try {
    const snap = await db.collection('guestReservations')
      .where('hotel', '==', hotelNameOrId)
      .limit(cap)
      .get();

    if (!snap.empty) {
      for (const doc of snap.docs) {
        const r = doc.data() || {};
        if (!r.room) continue;
        
        const roomNo = String(r.room);
        
        // CRITICAL: Only process rooms that are in our inventory
        if (!roomsMap.has(roomNo)) {
          console.log(`⚠️ Skipping invalid room number ${roomNo} found in old reservations`);
          continue;
        }
        
        const roomEntry = roomsMap.get(roomNo);

        // Update roomtype ONLY from guestReservations data
        if (r.roomtype && !roomEntry.roomtype) {
          roomEntry.roomtype = String(r.roomtype);
        }

        // Update price ONLY from guestReservations data
        if (!roomEntry.samplePriceNum) {
          const priceValue = r.price || r.rate || r.cost;
          if (priceValue) {
            const pnum = parsePrice(priceValue);
            if (Number.isFinite(pnum) && pnum > 0) {
              roomEntry.samplePriceNum = pnum;
              roomEntry.samplePriceStr = formatCurrency(pnum);
            }
          }
        }

        const updated = toDateSafe(r.updatedAt) || toDateSafe(r.createdAt) || null;
        if (updated && (!roomEntry.lastSeenAt || updated > roomEntry.lastSeenAt)) {
          roomEntry.lastSeenAt = updated;
        }
      }
    }
  } catch (err) {
    console.error('ERROR enhancing rooms from guestReservations:', err.message || err);
  }
  
  // For rooms with no data from guestReservations, use simple "Room" label
  for (const [roomNo, info] of roomsMap.entries()) {
    if (!info.roomtype) {
      info.roomtype = `Room ${roomNo}`;
    }
  }
  
  return roomsMap;
}

// Helper: Fallback to scan rooms from reservations if no inventory defined
async function scanRoomsFromReservations(hotelNameOrId, cap = 2000) {
  const rooms = new Set();
  try {
    const snap = await db.collection('guestReservations')
      .where('hotel', '==', hotelNameOrId)
      .limit(cap)
      .get();

    if (!snap.empty) {
      for (const doc of snap.docs) {
        const r = doc.data() || {};
        if (r.room) rooms.add(String(r.room));
      }
    }
  } catch (err) {
    console.error('ERROR scanning rooms:', err.message);
  }
  return Array.from(rooms);
}

/**
 * getAvailableRoomsByDate_fromReservations({ hotelId, hotelName, date, limit })
 * - Reads guestReservations to infer known rooms and compute which are occupied on `date`
 * - PRIVACY: Only accesses checkIn, checkOut, hotel, room, status fields
 * Returns: array of sanitized room objects: { roomnumber, roomtype, priceNum, priceStr, isAvailable }
 */
async function getAvailableRoomsByDate_fromReservations({ hotelId, hotelName, date, limit = 50 } = {}) {
  if (!hotelId && !hotelName) throw new Error('hotelId or hotelName required');

  let guestHotelName = hotelName;
  if (!guestHotelName && hotelId) {
    try {
      const hd = await db.collection('hotels').doc(hotelId).get();
      const hdata = hd.exists ? (hd.data() || {}) : {};
      guestHotelName = hdata.name || hotelId;
    } catch (err) {
      console.warn('WARN: failed to read hotel doc:', err.message || err);
      guestHotelName = hotelId;
    }
  }
  
  // Try fuzzy matching
  if (guestHotelName) {
    const matched = matchHotelName(guestHotelName);
    if (matched) {
      guestHotelName = matched;
    }
  }

  const occupiedSet = await getOccupiedRoomsForDate(guestHotelName, date);
  const roomsMap = await inferRoomsFromReservations(guestHotelName, 2000);
  const rooms = [];

  if (roomsMap.size === 0) {
    return [];
  }

  for (const [roomNo, info] of roomsMap.entries()) {
    const isOccupied = occupiedSet.has(roomNo);
    const isAvailable = !isOccupied;
    
    rooms.push({
      roomnumber: roomNo,
      roomtype: info.roomtype || `Room ${roomNo}`,
      priceNum: Number.isFinite(info.samplePriceNum) ? info.samplePriceNum : null,
      priceStr: info.samplePriceStr || null,
      isAvailable
    });
  }

  rooms.sort((a, b) => {
    if (a.isAvailable && !b.isAvailable) return -1;
    if (!a.isAvailable && b.isAvailable) return 1;
    return parseInt(a.roomnumber) - parseInt(b.roomnumber);
  });

  return rooms.filter(r => r.isAvailable).slice(0, limit);
}

/**
 * extractDateRangeFromQuery(userMessage)
 * Extracts date ranges from natural language like:
 *   - "December 8, 2025 to December 20, 2025"
 *   - "from Dec 8 to Dec 20"
 *   - "12/8/2025 to 12/20/2025"
 *   - "2025-12-08 to 2025-12-20"
 * Returns: { startDate: Date, endDate: Date, raw: { start, end } } or null
 */
function extractDateRangeFromQuery(userMessage) {
  if (!userMessage) return null;

  const monthMap = {
    jan: 0, january: 0,
    feb: 1, february: 1,
    mar: 2, march: 2,
    apr: 3, april: 3,
    may: 4,
    jun: 5, june: 5,
    jul: 6, july: 6,
    aug: 7, august: 7,
    sep: 8, sept: 8, september: 8,
    oct: 9, october: 9,
    nov: 10, november: 10,
    dec: 11, december: 11
  };

  // Pattern 1: "December 8 to December 20, 2025" or "Dec 8 to Dec 20 2025"
  let match = userMessage.match(/(\w+)\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?\s+(?:to|until|-)\s+(\w+)\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?/i);
  
  if (match) {
    console.log(`   📅 Matched pattern 1 (month name format): "${match[0]}"`);
    
    const startMonth = monthMap[match[1].toLowerCase()];
    const startDay = parseInt(match[2]);
    const endMonth = monthMap[match[4].toLowerCase()];
    const endDay = parseInt(match[5]);
    
    // Use explicit year if provided, otherwise current year
    const currentYear = new Date().getFullYear();
    const startYear = match[3] ? parseInt(match[3]) : (match[6] ? parseInt(match[6]) : currentYear);
    const endYear = match[6] ? parseInt(match[6]) : startYear;
    
    if (startMonth !== undefined && endMonth !== undefined) {
      const startDate = new Date(Date.UTC(startYear, startMonth, startDay));
      const endDate = new Date(Date.UTC(endYear, endMonth, endDay));
      
      console.log(`   📅 Parsed: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);
      
      return {
        startDate,
        endDate,
        raw: { start: match[0], end: match[0] }
      };
    }
  }

  // Pattern 2: MM/DD/YYYY to MM/DD/YYYY
  match = userMessage.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(?:to|until|-)\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  if (match) {
    console.log(`   📅 Matched pattern 2 (MM/DD/YYYY format): "${match[0]}"`);
    
    const startDate = new Date(Date.UTC(parseInt(match[3]), parseInt(match[1]) - 1, parseInt(match[2])));
    const endDate = new Date(Date.UTC(parseInt(match[6]), parseInt(match[4]) - 1, parseInt(match[5])));
    
    return {
      startDate,
      endDate,
      raw: { start: match[0], end: match[0] }
    };
  }

  // Pattern 3: YYYY-MM-DD to YYYY-MM-DD
  match = userMessage.match(/(\d{4})-(\d{1,2})-(\d{1,2})\s+(?:to|until|-)\s+(\d{4})-(\d{1,2})-(\d{1,2})/i);
  if (match) {
    console.log(`   📅 Matched pattern 3 (YYYY-MM-DD format): "${match[0]}"`);
    
    const startDate = new Date(Date.UTC(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3])));
    const endDate = new Date(Date.UTC(parseInt(match[4]), parseInt(match[5]) - 1, parseInt(match[6])));
    
    return {
      startDate,
      endDate,
      raw: { start: match[0], end: match[0] }
    };
  }

  return null;
}

/**
 * checkAvailabilityForDateRange({ hotelName, startDate, endDate })
 * Checks room availability for a date range
 */
async function checkAvailabilityForDateRange({ hotelName, startDate, endDate }) {
  const queryStart = normalizeDateToUTC(startDate);
  const queryEnd = normalizeDateToUTC(endDate);
  
  // Get all rooms for this hotel
  const roomsMap = await inferRoomsFromReservations(hotelName, 2000);
  
  if (roomsMap.size === 0) {
    return {
      available: false,
      availableCount: 0,
      occupiedCount: 0,
      availableRooms: [],
      occupiedRooms: [],
      dateRange: { startDate: queryStart, endDate: queryEnd, nights: 0 }
    };
  }

  // For each day in the range, collect occupied rooms
  const occupiedRoomNumbers = new Set();
  
  let currentDate = new Date(queryStart);
  while (currentDate < queryEnd) {
    const occupiedToday = await getOccupiedRoomsForDate(hotelName, currentDate);
    for (const roomNo of occupiedToday) {
      occupiedRoomNumbers.add(roomNo);
    }
    currentDate.setUTCDate(currentDate.getUTCDate() + 1);
  }

  // Build available and occupied room lists
  const availableRooms = [];
  const occupiedRoomDetails = [];

  for (const [roomNo, info] of roomsMap.entries()) {
    const roomData = {
      roomnumber: roomNo,
      roomtype: info.roomtype || `Room ${roomNo}`,
      priceNum: info.samplePriceNum,
      priceStr: info.samplePriceStr
    };

    if (occupiedRoomNumbers.has(roomNo)) {
      occupiedRoomDetails.push(roomData);
    } else {
      availableRooms.push(roomData);
    }
  }

  // Sort rooms by room number
  availableRooms.sort((a, b) => parseInt(a.roomnumber) - parseInt(b.roomnumber));
  occupiedRoomDetails.sort((a, b) => parseInt(a.roomnumber) - parseInt(b.roomnumber));

  return {
    available: availableRooms.length > 0,
    availableCount: availableRooms.length,
    occupiedCount: occupiedRoomNumbers.size,
    availableRooms: availableRooms.slice(0, 10),
    occupiedRooms: occupiedRoomDetails.slice(0, 10),
    dateRange: {
      startDate: queryStart,
      endDate: queryEnd,
      nights: Math.ceil((queryEnd - queryStart) / (1000 * 60 * 60 * 24))
    }
  };
}

// Try to answer price queries deterministically from shortCtx Rooms string.
function extractPriceAnswerFromShortCtx(userMessage, shortCtx) {
  if (!shortCtx || !shortCtx.includes('Rooms:')) return null;
  const roomsStart = shortCtx.indexOf('Rooms:');
  let roomsSub = shortCtx.slice(roomsStart + 'Rooms:'.length).trim();
  const nextPipe = roomsSub.indexOf(' | ');
  if (nextPipe !== -1) roomsSub = roomsSub.slice(0, nextPipe).trim();

  const entries = roomsSub.split(';').map(s => s.trim()).filter(Boolean);
  const parsed = entries.map(entry => {
    let type = null, nights = null, priceStr = null;
    const emDashMatch = entry.match(/—\s*(.+)$/);
    const hyphenMatch = !emDashMatch && entry.match(/-\s*(.+)$/);
    const pricePart = emDashMatch ? emDashMatch[1] : (hyphenMatch ? hyphenMatch[1] : null);
    priceStr = pricePart ? pricePart.trim() : null;
    const left = pricePart ? entry.slice(0, entry.indexOf(pricePart)).trim() : entry;
    const leftClean = left.replace(/[:—-]$/, '').trim();
    const typeMatch = leftClean.match(/^([^:(]+)(:[:(].*)?$/);
    type = typeMatch ? typeMatch[1].trim() : leftClean;
    const nightsMatch = leftClean.match(/(\d+)\s*nights?/i) || leftClean.match(/\((\d+)\s*nights?\)/i);
    nights = nightsMatch ? `${nightsMatch[1]} night${nightsMatch[1] === '1' ? '' : 's'}` : null;
    return { type: type.toLowerCase(), displayType: type, nights, priceStr };
  });

  const q = normalizeText(userMessage || '');
  const qTokens = q.split(" ").filter(Boolean);

  let matchedEntry = null;
  for (const p of parsed) {
    const typeTokens = p.type.split(" ").filter(Boolean);
    const overlap = qTokens.some(token => typeTokens.some(tt => tt.includes(token) || token.includes(tt)));
    if (overlap) {
      matchedEntry = p;
      break;
    }
  }

  if (!matchedEntry) {
    const tokens = q.split(' ');
    for (const token of tokens) {
      if (!token) continue;
      const found = parsed.find(p => p.type.includes(token) || token.includes(p.type));
      if (found) { matchedEntry = found; break; }
    }
  }

  const isPriceQuestion = /\b(price|cost|how much|rate|how much is|how much are)\b/i.test(userMessage || '');
  if (matchedEntry) {
    const nightsText = matchedEntry.nights ? ` (${matchedEntry.nights})` : '';
    return `${matchedEntry.displayType}: ${matchedEntry.priceStr}${nightsText}`;
  } else if (isPriceQuestion) {
    if (parsed.length === 0) return null;
    const summary = parsed.map(p => `${p.displayType}: ${p.priceStr}${p.nights ? ` (${p.nights})` : ''}`).join('; ');
    return `Available room prices: ${summary}`;
  }

  return null;
}

// --- Helper: Simple fuzzy-ish name-based retrieval (less strict) ---
async function findDocByName(query) {
  const q = normalizeText(query || '');
  if (!q) return null;

  const tokens = q.split(" ").filter(Boolean);
  const snapshot = await db.collection('hotels').get();
  let bestMatch = null;
  let bestScore = 0;

  for (const doc of snapshot.docs) {
    const d = doc.data() || {};
    const hotelId = doc.id.toLowerCase();
    const name = (d.name || "").toLowerCase();
    const aliases = (d.aliases || []).map(a => (a || "").toLowerCase());
    const loc = (d.location || "").toLowerCase();

    const haystack = [hotelId, name, loc, aliases.join(' ')].join(" ");
    let score = 0;
    for (const t of tokens) {
      if (t.length < 2) continue;
      if (haystack.includes(t)) score++;
    }
    if (haystack.includes(q)) score += 2;
    if (score > bestScore) {
      bestScore = score;
      bestMatch = { id: doc.id, data: d };
    }
  }

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

    console.log('🔍 Fetching Knowledge Base (including hotel subcollection FAQs and rooms inferred from guestReservations).');

    // 1. Fetch Hotel Data
    const hotelsSnapshot = await db.collection('hotels').get();
    if (!hotelsSnapshot.empty) {
      for (const hotelDoc of hotelsSnapshot.docs) {
        docCount++;
        const d = hotelDoc.data() || {};
        const hotelId = hotelDoc.id;

        // --- A. Fetch Rooms (inferred from guestReservations only) ---
        let roomsText = '';
        try {
          const roomLines = [];

          // Determine hotelName used in guestReservations (prefer stored name)
          const hotelNameForRes = (d && d.name) ? d.name : hotelId;

          // Use today's date (hotel-local) as the default
          const todayStr = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'

          // Call reservations-only helper to get available rooms for the date
          const availableRooms = await getAvailableRoomsByDate_fromReservations({ hotelId, hotelName: hotelNameForRes, date: todayStr, limit: ROOM_LIMIT });

          if (!availableRooms || availableRooms.length === 0) {
            // If we inferred no rooms at all, try to give a textual hint (no PII).
            const anyResSnap = await db.collection('guestReservations').where('hotel', '==', hotelNameForRes).limit(1).get();
            if (anyResSnap.empty) {
              roomLines.push('No reservation history found for this hotel; cannot infer room list from dashboard.');
            } else {
              roomLines.push('No rooms available for selected date (based on reservations dashboard).');
            }
          } else {
            for (const r of availableRooms) {
              // Keep the line public & concise: no guest names / no booking ids
              const pricePart = r.priceStr ? ` — ${r.priceStr}` : '';
              roomLines.push(`${r.roomtype} #${r.roomnumber}${pricePart}`);
            }
          }

          roomsText = roomLines.join('; ');
        } catch (err) {
          console.warn(`⚠️ Could not load rooms (reservations-only) for hotel ${hotelId}:`, err.message);
          roomsText = 'Rooms info not available from reservation dashboard.';
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
    // DISABLED: Reading from 'chatbot' collection was pulling old test/placeholder data
    // into the knowledge base context, causing irrelevant responses.
    // Questions are still LOGGED to 'chatbot' collection, but not used as context.
    // If you have curated FAQs, consider putting them in a separate 'faqs' collection
    // or in the hotels/{hotelId}/faqs subcollection instead.
    /*
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
    */

    console.log(`✅ Loaded ${docCount} documents/records for context.`);
    if (lines.length === 0) return 'No information available.';
    return lines.join('\n\n');
  } catch (error) {
    console.error('❌ Error fetching Firestore data:', error);
    return '';
  }
}

// --- Categorize question using Gemini ---
async function categorizeQuestion(questionText) {
  try {
    const prompt = `Categorize the following hotel-related question into one of these categories: 
    - "availability" (room availability, booking status)
    - "pricing" (room prices, rates, costs)
    - "amenities" (facilities, services, features)
    - "location" (directions, nearby places)
    - "policies" (check-in/out, cancellation, rules)
    - "general" (anything else)
    
    Question: "${questionText}"
    
    Respond with ONLY the category name, nothing else.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const category = (response.text() || '').trim().toLowerCase();
    
    const validCategories = ['availability', 'pricing', 'amenities', 'location', 'policies', 'general'];
    return validCategories.includes(category) ? category : 'general';
  } catch (err) {
    console.warn('Failed to categorize question:', err.message);
    return 'general';
  }
}

// --- Web Chat Endpoint (for in-app chatbot widget) - WITH FULL DIAGNOSTICS ---
app.post('/chat', async (req, res) => {
  try {
    const userMessage = (req.body && req.body.message ? String(req.body.message) : '').trim();
    const userId = (req.body && req.body.userId ? String(req.body.userId) : 'web');

    if (!userMessage) {
      return res.status(400).json({ error: 'missing_message' });
    }

    console.log(`\n📨 RECEIVED CHAT MESSAGE: "${userMessage}"`);

    // Best-effort: save raw question in chatbot collection
    let savedQuestionMeta = null;
    try {
      savedQuestionMeta = await saveUserQuestion(userMessage);
    } catch (err) {
      console.warn('WEBCHAT: failed to save question (non-fatal):', err.message || err);
    }

    // ========== STEP 1: Check if it's an availability query ==========
    const isAvailabilityQuery = /\b(available|vacant|vacancy|vacancies|booked|occupied|free|rooms?|check|stay|empty|open)\b/i.test(userMessage);
    console.log(`\n1️⃣  Is availability query? ${isAvailabilityQuery}`);

    let enrichedContext = '';
    let dateRange = null;

    if (isAvailabilityQuery) {
      // ========== STEP 2: Extract date range ==========
      dateRange = extractDateRangeFromQuery(userMessage);
      console.log(`2️⃣  Date range extracted: ${dateRange ? `${dateRange.startDate.toISOString().split('T')[0]} to ${dateRange.endDate.toISOString().split('T')[0]}` : 'NONE'}`);

      if (dateRange) {
        // ========== STEP 3: Get all unique hotel names from guestReservations ==========
        let availableHotels = new Set();
        try {
          const resSnap = await db.collection('guestReservations').limit(1000).get();
          resSnap.forEach(doc => {
            const d = doc.data() || {};
            if (d.hotel) availableHotels.add(d.hotel);
          });
        } catch (err) {
          console.warn('Could not fetch hotels from guestReservations:', err.message);
        }

        console.log(`Searching in available hotels: ${Array.from(availableHotels).join(', ')}`);

        // ========== STEP 4: Find matching hotel in user message ==========
        let hotelName = null;

        for (const hotel of availableHotels) {
          if (userMessage.toLowerCase().includes(hotel.toLowerCase())) {
            hotelName = hotel;
            console.log(`✅ MATCHED hotel: "${hotelName}"`);
            break;
          }
        }

        if (!hotelName) {
          console.log(`❌ NO hotel match found in message`);
        }

        // ========== STEP 5: Check availability ==========
        if (hotelName) {
          console.log(`\n4️⃣  Checking availability for "${hotelName}"...`);

          try {
            const availability = await checkAvailabilityForDateRange({
              hotelName,
              startDate: dateRange.startDate,
              endDate: dateRange.endDate
            });

            console.log(`   ✅ Availability check complete:`);
            console.log(`      Available: ${availability.availableCount}`);
            console.log(`      Occupied: ${availability.occupiedCount}`);
            console.log(`      Total known rooms: ${availability.availableCount + availability.occupiedCount}`);

            // ========== STEP 6: Build enriched context ==========
            const formatDateRange = (d) => {
              const m = (d.getMonth() + 1).toString().padStart(2, '0');
              const day = d.getDate().toString().padStart(2, '0');
              const y = d.getFullYear();
              return `${m}/${day}/${y}`;
            };

            enrichedContext = `
[REAL-TIME AVAILABILITY DATA for ${hotelName}]
Date Range Requested: ${formatDateRange(availability.dateRange.startDate)} to ${formatDateRange(availability.dateRange.endDate)} (${availability.dateRange.nights} nights)
Available Rooms: ${availability.availableCount}
Occupied Rooms: ${availability.occupiedCount}
Total Rooms Known: ${availability.availableCount + availability.occupiedCount}

${availability.available ? '✅ GOOD NEWS: There are available rooms for your dates!' : '❌ Unfortunately, NO rooms are available for your requested date range.'}

Available Room Details:
${availability.availableRooms.length > 0
    ? availability.availableRooms.map(r => `  • Room #${r.roomnumber} (${r.roomtype})${r.priceStr ? ` - ${r.priceStr}/night` : ''}`).join('\n')
    : '  • None available for this date range'}

Occupied Rooms: ${availability.occupiedCount} room(s) are booked during this period
            `;

            console.log(`\n5️⃣  Enriched context built (${enrichedContext.length} chars)\n`);

          } catch (err) {
            console.warn('WEBCHAT: failed to check availability (non-fatal):', err.message);
          }
        } else {
          console.log(`   ⚠️  Cannot check availability without hotel name match`);
        }
      }
    }

    // ========== STEP 7: Build LLM prompt ==========
    let knowledgeBase = await getKnowledgeBase();
    const MAX_CHARS = 15000;
    if (knowledgeBase && knowledgeBase.length > MAX_CHARS) {
      console.warn('WEBCHAT: knowledge base large; truncating.');
      knowledgeBase = knowledgeBase.slice(0, MAX_CHARS) + '\n\n[TRUNCATED]';
    }

    const prompt = `
You are a helpful hotel reservation assistant for the hotel group. Answer questions about room availability, pricing, and reservations.

${enrichedContext ? `REAL-TIME AVAILABILITY DATA (use this first if available):\n${enrichedContext}\n\n` : ''}

GENERAL KNOWLEDGE BASE:
${knowledgeBase || 'No information available.'}

USER QUESTION:
"${userMessage}"

INSTRUCTIONS:
- If real-time availability data is provided above, use it to answer the question directly
- For availability questions with specific dates, always reference the real-time data if available
- Be specific with room numbers and pricing
- Keep responses friendly and concise
- Never make up information not in the context
    `.trim();

    console.log(`6️⃣  LLM Prompt prepared (${prompt.length} chars)`);
    console.log(`   Using enriched context: ${enrichedContext ? 'YES ✅' : 'NO ❌'}\n`);

    // ========== STEP 8: Call Gemini ==========
    console.log(`7️⃣  Calling Gemini API...`);
    const result = await model.generateContent(prompt);
    const response = await result.response;
    let botReply = (response && typeof response.text === 'function') ? response.text() : (response?.output?.text ?? '');
    botReply = (botReply || '').trim();

    if (!botReply) {
      console.warn('WEBCHAT: empty model response, using fallback message.');
      botReply = "I'm sorry, I couldn't find the information you requested. Could you try rephrasing your question or specifying a hotel name?";
    }

    console.log(`✅ BOT RESPONSE:\n${botReply}\n`);

    // ========== STEP 9: Save answer and log ==========
    if (savedQuestionMeta && savedQuestionMeta.id) {
      try {
        await db.collection('chatbot').doc(savedQuestionMeta.id).set({ answer: botReply }, { merge: true });
      } catch (err) {
        console.warn('WEBCHAT: failed to attach answer to chatbot doc (non-fatal):', err.message || err);
      }
    }

    try {
      await logConversation(userId, userMessage, botReply + '\n\n[WEBCHAT]');
    } catch (err) {
      console.warn('WEBCHAT: failed to log conversation (non-fatal):', err.message || err);
    }

    return res.json({ reply: botReply });

  } catch (error) {
    console.error('❌ WEBCHAT: error handling /chat:', error);
    return res.status(500).json({ error: 'chat_failed', message: error.message || String(error) });
  }
});

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
async function saveUserQuestion(questionText) {
  if (!questionText || !questionText.trim()) return null;
  const qTrim = questionText.trim();

  try {
    // Categorize the question (try model classifier, fall back to rule-based)
    const category = (await categorizeQuestion(qTrim)) || 'general';

    // Always write a fresh document so each interaction has its own record
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

// --- Facebook Webhook Verification ---
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
      console.log('✅ Webhook verified');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

// --- Facebook Webhook Messages ---
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object === 'page') {
    res.status(200).send('EVENT_RECEIVED');

    for (const entry of body.entry || []) {
      const webhookEvent = entry.messaging && entry.messaging[0];
      if (webhookEvent && webhookEvent.message && webhookEvent.message.text) {
        const senderPsid = webhookEvent.sender.id;
        const userMessage = webhookEvent.message.text;

        console.log(`\n📩 MESSENGER: Received from ${senderPsid}: "${userMessage}"`);

        // Check for availability query with date range
        const isAvailabilityQuery = /\b(available|vacant|vacancy|vacancies|booked|occupied|free|rooms?|check|stay|empty|open)\b/i.test(userMessage);
        let enrichedContext = '';

        if (isAvailabilityQuery) {
          try {
            const dateRange = extractDateRangeFromQuery(userMessage);
            if (dateRange) {
              // Find hotel name in message
              let hotelName = null;
              for (const [name, aliases] of Object.entries(HOTEL_NAME_ALIASES)) {
                if (name && userMessage.toLowerCase().includes(name.toLowerCase())) {
                  hotelName = name;
                  break;
                }
                for (const alias of aliases) {
                  if (alias && userMessage.toLowerCase().includes(alias.toLowerCase())) {
                    hotelName = name || alias;
                    break;
                  }
                }
              }

              if (hotelName) {
                console.log('WEBHOOK: Detected availability query for hotel:', hotelName);
                const availability = await checkAvailabilityForDateRange({
                  hotelName,
                  startDate: dateRange.startDate,
                  endDate: dateRange.endDate
                });

                const formatDateRange = (d) => {
                  const m = (d.getMonth() + 1).toString().padStart(2, '0');
                  const day = d.getDate().toString().padStart(2, '0');
                  const y = d.getFullYear();
                  return `${m}/${day}/${y}`;
                };

                // PRIVACY: NO GUEST NAMES IN RESPONSE
                enrichedContext = `
[AVAILABILITY for ${hotelName}]
Dates: ${formatDateRange(availability.dateRange.startDate)} - ${formatDateRange(availability.dateRange.endDate)}
Available: ${availability.availableCount} room(s)
Occupied: ${availability.occupiedCount} room(s)

${availability.availableRooms.map(r => `• ${r.roomtype} #${r.roomnumber}${r.priceStr ? ` (${r.priceStr})` : ''}`).join('\n')}
                `;
              }
            }
          } catch (err) {
            console.warn('WEBHOOK: failed to check availability:', err.message);
          }
        }

        // --- B. Try to find matched hotel if availability query didn't find one ---
        let matched = null;
        if (!enrichedContext) {
          try {
            matched = await findDocByName(userMessage);
          } catch (err) {
            console.warn('WARN: findDocByName failed:', err.message || err);
          }
        }

        let prompt = '';

        // If matched, build a small targeted context
        if (matched && matched.id) {
          let d = matched.data || {};
          let rooms = null;
          try {
            const todayStr = new Date().toISOString().slice(0, 10);
            const inferredRooms = await getAvailableRoomsByDate_fromReservations({ hotelId: matched.id, hotelName: d.name || matched.id, date: todayStr, limit: 12 });

            if (inferredRooms && inferredRooms.length > 0) {
              const rlines = inferredRooms.map(rr => {
                const p = rr.priceStr ? ` — ${rr.priceStr}` : '';
                return `${rr.roomtype} #${rr.roomnumber}${p}`;
              });
              rooms = rlines.join('; ');
            } else {
              const anyResSnap = await db.collection('guestReservations').where('hotel', '==', (d.name || matched.id)).limit(1).get();
              if (anyResSnap.empty) {
                rooms = 'No reservation history found for this hotel; cannot infer room list from dashboard.';
              } else {
                rooms = 'No rooms available for selected date (based on reservations dashboard).';
              }
            }
          } catch (err) {
            console.warn('⚠️ Could not infer rooms for matched hotel:', err.message);
            rooms = 'Rooms info not available from reservation dashboard.';
          }

          let calculationNote = null;
          try {
            calculationNote = await extractPriceAnswerFromShortCtx(userMessage, `Rooms: ${rooms || ''}`);
          } catch (err) {
            // ignore
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

${enrichedContext ? `REAL-TIME DATA:\n${enrichedContext}\n` : ''}

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

${enrichedContext ? `REAL-TIME DATA:\n${enrichedContext}\n` : ''}

CONTEXT INFORMATION:
${knowledgeBase || "No information available."}

USER QUESTION:
${userMessage}
          `.trim();

          console.log('DEBUG: Using full context (truncated):', knowledgeBase ? knowledgeBase.slice(0, 1000) : knowledgeBase);
        }

        try {
          console.log('DEBUG: Prompt length', prompt.length);
          const result = await model.generateContent(prompt);
          const response = await result.response;
          let botReply = (response && typeof response.text === 'function') ? response.text() : (response?.output?.text ?? '');
          botReply = (botReply || '').trim();

          if (!botReply) {
            console.warn('⚠️ Model returned empty response. Sending fallback message.');
            botReply = "I'm sorry, I couldn't find the information you requested in my context. Could you clarify the hotel name or ask about something else?";
          }

          await sendMessengerReply(senderPsid, botReply);

          await logConversation(senderPsid, userMessage, botReply + "\n\n[CONTEXT TRUNCATED FOR LOGGING]");

        } catch (error) {
          console.error('Error in AI processing:', error);
          await sendMessengerReply(senderPsid, "I'm having trouble connecting right now. Please try again later.");
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
