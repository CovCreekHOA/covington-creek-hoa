// ═══════════════════════════════════════════════════════════════════════════════
// Covington Creek HOA — Automation Backend v2.0
// Deploy to Render.com
// ═══════════════════════════════════════════════════════════════════════════════
//
// Required environment variables (set in Render dashboard):
//   DATABASE_URL              — auto-set by Render PostgreSQL
//   PAYPAL_CLIENT_ID          — Live app Client ID
//   PAYPAL_CLIENT_SECRET      — Live app Secret
//   PAYPAL_MODE               — "live" or "sandbox"
//   PAYPAL_WEBHOOK_ID         — from PayPal developer dashboard
//   PAYPAL_SANDBOX_CLIENT_ID  — Sandbox app Client ID
//   PAYPAL_SANDBOX_SECRET     — Sandbox app Secret
//   GMAIL_USER                — CovingtonCreek.HOA96@gmail.com
//   GMAIL_APP_PASSWORD        — 16-char App Password
//   BOARD_EMAIL               — bkahlquist@gmail.com
//   TWILIO_ACCOUNT_SID        — from twilio.com dashboard
//   TWILIO_AUTH_TOKEN         — from twilio.com dashboard
//   TWILIO_PHONE_NUMBER       — your Twilio number e.g. +13305550100
//   FRONTEND_URL              — your deployed app URL
//   TEST_MODE                 — "true" or "false" (default false)
//   TEST_EMAIL_REDIRECT       — board email to receive all test emails
// ═══════════════════════════════════════════════════════════════════════════════

const express    = require("express");
const cors       = require("cors");
const nodemailer = require("nodemailer");
const cron       = require("node-cron");
const { Pool }   = require("pg");
const twilio     = require("twilio");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: "*" }));
app.use(express.json({ verify: (req, _, buf) => { req.rawBody = buf; } }));

// ─── Test mode ─────────────────────────────────────────────────────────────────
function isTestMode()      { return process.env.TEST_MODE === "true"; }
function isDryRun()        { return process.env.DRY_RUN === "true"; }
function getPayPalBase()   { return (isTestMode() ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com"); }
function getPayPalCreds()  {
  return isTestMode()
    ? { id: process.env.PAYPAL_SANDBOX_CLIENT_ID, secret: process.env.PAYPAL_SANDBOX_SECRET }
    : { id: process.env.PAYPAL_CLIENT_ID,         secret: process.env.PAYPAL_CLIENT_SECRET };
}
function resolveEmail(email) {
  if (isTestMode()) return process.env.TEST_EMAIL_REDIRECT || process.env.BOARD_EMAIL;
  return email;
}
function resolvePhone(phone) {
  if (isTestMode()) return null; // suppress SMS in test mode unless dry run logging
  return phone;
}

// ─── PostgreSQL ─────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("render.com") ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS residents (
      id         BIGINT PRIMARY KEY,
      address    TEXT NOT NULL UNIQUE,
      data       JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      data       JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ledger (
      id         TEXT PRIMARY KEY,
      data       JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_res_addr  ON residents(LOWER(address));
    CREATE INDEX IF NOT EXISTS idx_res_email ON residents((data->>'email1'));
  `);
  console.log("Database ready");
}

async function dbRead() {
  const r = await pool.query("SELECT data FROM residents ORDER BY created_at DESC");
  return r.rows.map(r => r.data);
}

async function dbUpsertOne(resident) {
  await pool.query(
    `INSERT INTO residents (id, address, data, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (address) DO UPDATE SET data = $3, updated_at = NOW()`,
    [resident.id, resident.address, JSON.stringify(resident)]
  );
}

async function dbWrite(residents) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const r of residents) await dbUpsertOne(r);
    await client.query("COMMIT");
  } catch(e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}

async function getSchedule() {
  try {
    const r = await pool.query("SELECT data FROM settings WHERE key = 'schedule' LIMIT 1");
    return r.rows[0]?.data || DEFAULT_SCHEDULE;
  } catch { return DEFAULT_SCHEDULE; }
}

async function getLedger() {
  try {
    const r = await pool.query("SELECT data FROM ledger ORDER BY created_at DESC");
    return r.rows.map(r => r.data);
  } catch { return []; }
}

async function addLedgerEntry(entry) {
  await pool.query(
    "INSERT INTO ledger (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2",
    [entry.id, JSON.stringify(entry)]
  );
}

// ─── Default schedule ──────────────────────────────────────────────────────────
const YEAR = new Date().getFullYear();
const DEFAULT_SCHEDULE = {
  year: YEAR, duesAmount: 120,
  dueDeadline:     `${YEAR}-06-15`,
  invoiceSendDate: `${YEAR}-05-01`,
  memberReminder1: `${YEAR}-06-01`,
  memberReminder2: `${YEAR}-06-20`,
  touch1Date:      `${YEAR}-05-01`,
  touch2Date:      `${YEAR}-06-01`,
  touch3Date:      `${YEAR}-06-20`,
  weeklyBoardUpdate: true,
  boardEmail: process.env.BOARD_EMAIL,
};

// ─── Seed data ──────────────────────────────────────────────────────────────────
const SEED_RESIDENTS = [
  {
    "id": 1704067200000,
    "address": "8025 Camden Way",
    "name1": "John & Tammy Marino",
    "name2": "",
    "email1": "johnmarino28@yahoo.com",
    "email2": "",
    "phone1": "330-507-3436",
    "phone2": "",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2019,
      2020,
      2021,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 6,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200001,
    "address": "8027 Camden Way",
    "name1": "Jonathan & Kelly Pulido",
    "name2": "",
    "email1": "dr.jvp22@gmail.com",
    "email2": "kellypulido22@gmail.com",
    "phone1": "330-651-1809",
    "phone2": "330-518-1551",
    "memberStatus": "lapsed",
    "isMember": false,
    "paid_2024": true,
    "paid_2025": false,
    "paidYears": [
      2009,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2023,
      2024
    ],
    "mostRecentYear": 2024,
    "yearsParticipated": 9,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200002,
    "address": "8029 Camden Way",
    "name1": "Ron & Lisa Helmick",
    "name2": "",
    "email1": "rhelmick@zoominternet.net",
    "email2": "",
    "phone1": "330-718-9172",
    "phone2": "330-550-9753",
    "memberStatus": "lapsed",
    "isMember": false,
    "paid_2024": true,
    "paid_2025": false,
    "paidYears": [
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024
    ],
    "mostRecentYear": 2024,
    "yearsParticipated": 8,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200003,
    "address": "8031 Camden Way",
    "name1": "Mark & Melissa Miller",
    "name2": "",
    "email1": "iheartscouting@gmail.com",
    "email2": "mmiller25@zoominternet.net",
    "phone1": "330-207-0725",
    "phone2": "724-815-8359",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": false,
    "paid_2025": true,
    "paidYears": [
      2005,
      2006,
      2007,
      2008,
      2009,
      2010,
      2011,
      2013,
      2014,
      2015,
      2016,
      2017,
      2019,
      2020,
      2021,
      2022,
      2023,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 18,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200004,
    "address": "8033 Camden Way",
    "name1": "John & Dahlynn Falvy",
    "name2": "",
    "email1": "FalvyJohn@gmail.com",
    "email2": "falvydahl@hotmail.com",
    "phone1": "330-533-8404",
    "phone2": "",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2005,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 11,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200005,
    "address": "8034 Camden Way",
    "name1": "August & Melissa Seckler",
    "name2": "",
    "email1": "mseckler@zoominternet.net",
    "email2": "gusandmason@gmail.com",
    "phone1": "330-718-7983",
    "phone2": "330-718-8318",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 7,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200006,
    "address": "8035 Camden Way",
    "name1": "Tom & Tammy Porter",
    "name2": "",
    "email1": "tomandtam005@aol.com",
    "email2": "",
    "phone1": "330-406-6172",
    "phone2": "330-559-7548",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2006,
      2007,
      2008,
      2009,
      2011,
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 16,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200007,
    "address": "8036 Camden Way",
    "name1": "John Poultney",
    "name2": "",
    "email1": "jpoultney64@gmail.com",
    "email2": "",
    "phone1": "630-877-0660",
    "phone2": "",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2005,
      2006,
      2007,
      2008,
      2009,
      2013,
      2014,
      2015,
      2020,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 12,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200008,
    "address": "8037 Camden Way",
    "name1": "Edward & Joann Neiheisel",
    "name2": "",
    "email1": "",
    "email2": "",
    "phone1": "330-509-5474",
    "phone2": "330-881-0566",
    "memberStatus": "lapsed",
    "isMember": false,
    "paid_2024": true,
    "paid_2025": false,
    "paidYears": [
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024
    ],
    "mostRecentYear": 2024,
    "yearsParticipated": 10,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200009,
    "address": "8039 Camden Way",
    "name1": "Robert & Mary Lisa DiDomenico",
    "name2": "",
    "email1": "rojdd@aol.com",
    "email2": "",
    "phone1": "330-206-1439",
    "phone2": "",
    "memberStatus": "never_joined",
    "isMember": false,
    "paid_2024": false,
    "paid_2025": false,
    "paidYears": [],
    "mostRecentYear": null,
    "yearsParticipated": 0,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200010,
    "address": "8040 Camden Way",
    "name1": "Chris & Deanna Johnson",
    "name2": "",
    "email1": "",
    "email2": "",
    "phone1": "330-246-0553",
    "phone2": "",
    "memberStatus": "never_joined",
    "isMember": false,
    "paid_2024": false,
    "paid_2025": false,
    "paidYears": [],
    "mostRecentYear": null,
    "yearsParticipated": 0,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200011,
    "address": "8041 Camden Way",
    "name1": "John & Roberta Manzoian",
    "name2": "",
    "email1": "jmanzoian@aol.com",
    "email2": "",
    "phone1": "330-501-1295",
    "phone2": "",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2005,
      2006,
      2007,
      2008,
      2009,
      2010,
      2011,
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 17,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200012,
    "address": "8042 Camden Way",
    "name1": "Nicholas & Julianne Boniface",
    "name2": "",
    "email1": "juliannematthews1@gmail.com",
    "email2": "",
    "phone1": "330-402-2051",
    "phone2": "",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2005,
      2006,
      2007,
      2008,
      2009,
      2010,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 15,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200013,
    "address": "8043 Camden Way",
    "name1": "Joseph & Ann Marie Blumetti",
    "name2": "",
    "email1": "annmarieblumetti@yahoo.com",
    "email2": "",
    "phone1": "330-717-5000",
    "phone2": "330-360-4947",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 5,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200014,
    "address": "8045 Camden Way",
    "name1": "Robert & Margaret Garwood",
    "name2": "",
    "email1": "mgarwoodlive@hotmail.com",
    "email2": "",
    "phone1": "330-692-1209",
    "phone2": "330-233-1321",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2012,
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 12,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200015,
    "address": "8046 Camden Way",
    "name1": "Anthony & Joann Acierno",
    "name2": "",
    "email1": "trbikes@yahoo.com",
    "email2": "jacierno951@gmail.com",
    "phone1": "330-518-7046",
    "phone2": "330-518-7043",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2007,
      2008,
      2009,
      2010,
      2011,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 15,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200016,
    "address": "8048 Camden Way",
    "name1": "Faisal & Catherine Bajwa",
    "name2": "",
    "email1": "faisal.bajwa67@gmail.com",
    "email2": "",
    "phone1": "216-650-0621",
    "phone2": "330-321-3451",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 11,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200017,
    "address": "8050 Camden Way",
    "name1": "Lina Chiovitti-Lewis",
    "name2": "",
    "email1": "",
    "email2": "",
    "phone1": "",
    "phone2": "",
    "memberStatus": "dormant",
    "isMember": false,
    "paid_2024": false,
    "paid_2025": false,
    "paidYears": [
      2006,
      2007,
      2008,
      2009,
      2010,
      2019
    ],
    "mostRecentYear": 2019,
    "yearsParticipated": 6,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200018,
    "address": "8052 Camden Way",
    "name1": "Tony & Patty Kopatich",
    "name2": "",
    "email1": "anthonyK@zoominternet.net",
    "email2": "pattykopatich@zoominternet.net",
    "phone1": "330-719-6519",
    "phone2": "330-719-9396",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2012,
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 12,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200019,
    "address": "8053 Camden Way",
    "name1": "Tony & Patty Kopatich",
    "name2": "",
    "email1": "anthonyK@zoominternet.net",
    "email2": "",
    "phone1": "330-533-5626",
    "phone2": "",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2014,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 7,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200020,
    "address": "8059 Camden Way",
    "name1": "Tracy Symons",
    "name2": "",
    "email1": "tkopatich@yahoo.com",
    "email2": "",
    "phone1": "330-719-6494",
    "phone2": "",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2006,
      2007,
      2008,
      2009,
      2019,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 10,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200021,
    "address": "8060 Camden Way",
    "name1": "Chris & Lisa Farran",
    "name2": "",
    "email1": "farran2@aol.com",
    "email2": "",
    "phone1": "330-286-5027",
    "phone2": "",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2006,
      2007,
      2008,
      2009,
      2010,
      2011,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 15,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200022,
    "address": "8064 Camden Way",
    "name1": "Daniel & Brittany Marino",
    "name2": "",
    "email1": "daniel@extrusions.com",
    "email2": "brittanymarino.ahome4therapy@gmail.com",
    "phone1": "330-501-6528",
    "phone2": "330-942-0517",
    "memberStatus": "dormant",
    "isMember": false,
    "paid_2024": false,
    "paid_2025": false,
    "paidYears": [
      2005,
      2006,
      2007,
      2008,
      2009,
      2010,
      2011,
      2012,
      2013,
      2014,
      2015,
      2016
    ],
    "mostRecentYear": 2016,
    "yearsParticipated": 12,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200023,
    "address": "8066 Camden Way",
    "name1": "Don & Leslie Lewis",
    "name2": "",
    "email1": "lewis8066@aol.com",
    "email2": "",
    "phone1": "330-284-9495",
    "phone2": "330-651-2445",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2005,
      2006,
      2007,
      2008,
      2009,
      2010,
      2011,
      2012,
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 19,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200024,
    "address": "8070 Camden Way",
    "name1": "Eugene & Carol Calabria",
    "name2": "",
    "email1": "eugenec@gbscorp.com",
    "email2": "",
    "phone1": "330-702-1052",
    "phone2": "",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2011,
      2014,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 10,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200025,
    "address": "6600 Covington Cove",
    "name1": "Richard & Beth White",
    "name2": "",
    "email1": "rmwhite@ysu.edu",
    "email2": "bawhite4940@gmail.com",
    "phone1": "330-727-6408",
    "phone2": "330-720-1449",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 11,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200026,
    "address": "6601 Covington Cove",
    "name1": "Zev Randy & Angela Maycon",
    "name2": "",
    "email1": "a2zmaycon@yahoo.com",
    "email2": "",
    "phone1": "",
    "phone2": "",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2012,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 4,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200027,
    "address": "6602 Covington Cove",
    "name1": "Dale & Wanda Boerio",
    "name2": "",
    "email1": "",
    "email2": "",
    "phone1": "330-518-6693",
    "phone2": "330-533-1087",
    "memberStatus": "never_joined",
    "isMember": false,
    "paid_2024": false,
    "paid_2025": false,
    "paidYears": [],
    "mostRecentYear": null,
    "yearsParticipated": 0,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200028,
    "address": "6603 Covington Cove",
    "name1": "Nick & Kelly Shirey",
    "name2": "",
    "email1": "kshirey0913@gmail.com",
    "email2": "kshirey0913@gmail.com",
    "phone1": "330-307-8358",
    "phone2": "330-506-3934",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 7,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200029,
    "address": "6604 Covington Cove",
    "name1": "Byron & Jody Abrigg",
    "name2": "",
    "email1": "babrigg@zoominternet.net",
    "email2": "",
    "phone1": "330-503-1810",
    "phone2": "330-506-0498",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2005,
      2006,
      2007,
      2008,
      2009,
      2010,
      2011,
      2012,
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 19,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200030,
    "address": "6605 Covington Cove",
    "name1": "Landon & Emma Dame",
    "name2": "",
    "email1": "",
    "email2": "anthony.biegacki@covelli.com",
    "phone1": "",
    "phone2": "330-947-6811",
    "memberStatus": "new_owner",
    "isMember": false,
    "paid_2024": false,
    "paid_2025": false,
    "paidYears": [
      2021,
      2022,
      2023
    ],
    "mostRecentYear": 2023,
    "yearsParticipated": 3,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "county_import_new_owner",
    "notes": "New owner (sold by Biegacki Mar 2026) \u2014 contact info needed"
  },
  {
    "id": 1704067200031,
    "address": "6606 Covington Cove",
    "name1": "Darrell & Julie Pugh",
    "name2": "",
    "email1": "jmpugh73@gmail.com",
    "email2": "docpugh@yahoo.com",
    "phone1": "330-286-3166",
    "phone2": "330-507-5327",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2009,
      2014,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 8,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200032,
    "address": "6607 Covington Cove",
    "name1": "Adam & Shavelle Lonardo",
    "name2": "",
    "email1": "adamalonardo@gmail.com",
    "email2": "",
    "phone1": "330-716-0326",
    "phone2": "330-402-9662",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2005,
      2006,
      2007,
      2008,
      2009,
      2010,
      2011,
      2012,
      2013,
      2014,
      2015,
      2016,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 18,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200033,
    "address": "6608 Covington Cove",
    "name1": "Phil & Kim Wilson",
    "name2": "",
    "email1": "pwilson@zoominternet.net",
    "email2": "pwilson737@gmail.com",
    "phone1": "330-559-4936",
    "phone2": "330-519-9623",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2005,
      2006,
      2007,
      2008,
      2009,
      2011,
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 17,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200034,
    "address": "6609 Covington Cove",
    "name1": "Jeffrey & Rachel Barber",
    "name2": "",
    "email1": "",
    "email2": "lori@upwardsolutionscc.com",
    "phone1": "",
    "phone2": "440-476-1037",
    "memberStatus": "new_owner",
    "isMember": false,
    "paid_2024": true,
    "paid_2025": false,
    "paidYears": [
      2005,
      2006,
      2007,
      2008,
      2009,
      2010,
      2011,
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 17,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "county_import_new_owner",
    "notes": "New owner (sold by Gorrell May 2025) \u2014 contact info needed"
  },
  {
    "id": 1704067200035,
    "address": "6610 Covington Cove",
    "name1": "Joseph & Joann Bianco",
    "name2": "",
    "email1": "",
    "email2": "pattykopatich@zoominternet.net",
    "phone1": "",
    "phone2": "330-719-9396",
    "memberStatus": "new_owner",
    "isMember": false,
    "paid_2024": true,
    "paid_2025": false,
    "paidYears": [
      2005,
      2007,
      2008,
      2009,
      2010,
      2011,
      2012,
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2022,
      2024
    ],
    "mostRecentYear": 2024,
    "yearsParticipated": 15,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "county_import_new_owner",
    "notes": "New owner (sold by Kopatich Apr 2025) \u2014 contact info needed"
  },
  {
    "id": 1704067200036,
    "address": "6611 Covington Cove",
    "name1": "Mark & Sharon Carrocce",
    "name2": "",
    "email1": "scarr613@gmail.com",
    "email2": "mcarrocce@rjtrucking.com",
    "phone1": "330-519-9952",
    "phone2": "330-519-9958",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2005,
      2006,
      2007,
      2008,
      2009,
      2010,
      2011,
      2012,
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 19,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200037,
    "address": "6612 Covington Cove",
    "name1": "Ron & Diane Blaney",
    "name2": "",
    "email1": "dianeblaney@gmail.com",
    "email2": "",
    "phone1": "330-507-7654",
    "phone2": "330-533-2435",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2005,
      2008,
      2011,
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 14,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200038,
    "address": "6614 Covington Cove",
    "name1": "Sam & Lisa Cera",
    "name2": "",
    "email1": "scera1234@yahoo.com",
    "email2": "",
    "phone1": "330-727-8882",
    "phone2": "",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2005,
      2006,
      2007,
      2008,
      2009,
      2010,
      2011,
      2013,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 16,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200039,
    "address": "6615 Covington Cove",
    "name1": "Joe & Lisa Szul",
    "name2": "",
    "email1": "franco_lisa@yahoo.com",
    "email2": "dragum123@yahoo.com",
    "phone1": "724-601-0101",
    "phone2": "724-875-6682",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2005,
      2006,
      2012,
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 14,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200040,
    "address": "6616 Covington Cove",
    "name1": "Mark & Wendy Allison",
    "name2": "",
    "email1": "mallison1812@yahoo.com",
    "email2": "",
    "phone1": "330-718-4758",
    "phone2": "330-718-1595",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 5,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200041,
    "address": "6617 Covington Cove",
    "name1": "Matt & Pam Murdock & Massullo",
    "name2": "",
    "email1": "gmolds455@aol.com",
    "email2": "pam0020@aol.com",
    "phone1": "330-307-3654",
    "phone2": "614-598-9442",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2014,
      2015,
      2016,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 9,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200042,
    "address": "6618 Covington Cove",
    "name1": "Mitch & Darlene Dalvin",
    "name2": "",
    "email1": "drdalvinoffice@aol.com",
    "email2": "",
    "phone1": "330-702-1445",
    "phone2": "330-398-5463",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2005,
      2006,
      2007,
      2008,
      2009,
      2010,
      2011,
      2012,
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 19,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200043,
    "address": "6619 Covington Cove",
    "name1": "Manish & Chhaya Joshi",
    "name2": "",
    "email1": "bombayimports@hotmail.com",
    "email2": "",
    "phone1": "330-402-1260",
    "phone2": "330-550-4622",
    "memberStatus": "lapsed",
    "isMember": false,
    "paid_2024": false,
    "paid_2025": false,
    "paidYears": [
      2011,
      2012,
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023
    ],
    "mostRecentYear": 2023,
    "yearsParticipated": 11,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200044,
    "address": "6620 Covington Cove",
    "name1": "Jeff & Julie Palusak",
    "name2": "",
    "email1": "palusak@sbcglobal.net",
    "email2": "",
    "phone1": "330-509-8868",
    "phone2": "330-509-8869",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2012,
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 12,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200045,
    "address": "6621 Covington Cove",
    "name1": "David & Maria Sansoterra",
    "name2": "",
    "email1": "",
    "email2": "",
    "phone1": "",
    "phone2": "",
    "memberStatus": "dormant",
    "isMember": false,
    "paid_2024": false,
    "paid_2025": false,
    "paidYears": [
      2009,
      2010
    ],
    "mostRecentYear": 2010,
    "yearsParticipated": 2,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200046,
    "address": "6622 Covington Cove",
    "name1": "John & Brenda Wise",
    "name2": "",
    "email1": "jhw3676@aol.com",
    "email2": "",
    "phone1": "330-507-5421",
    "phone2": "330-921-5068",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 5,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200047,
    "address": "6623 Covington Cove",
    "name1": "Rob and Tracy Dovich",
    "name2": "",
    "email1": "rdovich@yahoo.com",
    "email2": "tracydovich@gmail.com",
    "phone1": "216-337-7767",
    "phone2": "",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2005,
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 12,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200048,
    "address": "6624 Covington Cove",
    "name1": "Allison Zwicker",
    "name2": "",
    "email1": "aazwick2@gmail.com",
    "email2": "",
    "phone1": "330-716-1101",
    "phone2": "",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2005,
      2006,
      2007,
      2008,
      2009,
      2010,
      2011,
      2012,
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 19,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200049,
    "address": "6625 Covington Cove",
    "name1": "Jeff & Amy Hermann",
    "name2": "",
    "email1": "amh1437@gmail.com",
    "email2": "",
    "phone1": "312-285-5052",
    "phone2": "",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2010,
      2012,
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 11,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200050,
    "address": "6626 Covington Cove",
    "name1": "Scott & Denise Duko",
    "name2": "",
    "email1": "duko@zoominternet.net",
    "email2": "",
    "phone1": "330-550-5428",
    "phone2": "",
    "memberStatus": "lapsed",
    "isMember": false,
    "paid_2024": true,
    "paid_2025": false,
    "paidYears": [
      2007,
      2008,
      2009,
      2010,
      2011,
      2012,
      2014,
      2015,
      2016,
      2023,
      2024
    ],
    "mostRecentYear": 2024,
    "yearsParticipated": 11,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200051,
    "address": "6627 Covington Cove",
    "name1": "Mark & Kera Constantini",
    "name2": "",
    "email1": "mark.constantini@outlook.com",
    "email2": "kyelkin@hotmail.com",
    "phone1": "330-207-2077",
    "phone2": "",
    "memberStatus": "lapsed",
    "isMember": false,
    "paid_2024": true,
    "paid_2025": false,
    "paidYears": [
      2005,
      2006,
      2007,
      2008,
      2009,
      2010,
      2011,
      2012,
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2022,
      2023,
      2024
    ],
    "mostRecentYear": 2024,
    "yearsParticipated": 17,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200052,
    "address": "6628 Covington Cove",
    "name1": "Brian & Melanie Pfau",
    "name2": "",
    "email1": "brianbpfau@gmail.com",
    "email2": "",
    "phone1": "330-398-8027",
    "phone2": "",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2005,
      2006,
      2007,
      2008,
      2009,
      2010,
      2011,
      2012,
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 18,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200053,
    "address": "6630 Covington Cove",
    "name1": "Bob & Mickie Smallwood",
    "name2": "",
    "email1": "bobsmallwood@zoominternet.net",
    "email2": "",
    "phone1": "330-506-1992",
    "phone2": "",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2005,
      2006,
      2007,
      2008,
      2009,
      2010,
      2011,
      2012,
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 19,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200054,
    "address": "6631 Covington Cove",
    "name1": "Greg & Lori Toporcer",
    "name2": "",
    "email1": "greg.toporcer@discoverglobal.com",
    "email2": "lori.toporcer@discoverglobal.com",
    "phone1": "330-559-2777",
    "phone2": "330-519-3438",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 7,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200055,
    "address": "6632 Covington Cove",
    "name1": "Karen Manenti",
    "name2": "",
    "email1": "",
    "email2": "",
    "phone1": "",
    "phone2": "",
    "memberStatus": "never_joined",
    "isMember": false,
    "paid_2024": false,
    "paid_2025": false,
    "paidYears": [],
    "mostRecentYear": null,
    "yearsParticipated": 0,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200056,
    "address": "6633 Covington Cove",
    "name1": "Bob & Mindy Hockenberry",
    "name2": "",
    "email1": "bob@accuformmfg.com",
    "email2": "mkrcelic@yahoo.com",
    "phone1": "330-360-0119",
    "phone2": "330-502-0699",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 10,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200057,
    "address": "6634 Covington Cove",
    "name1": "Tony & Irene Mehle",
    "name2": "",
    "email1": "amehle123@gmail.com",
    "email2": "",
    "phone1": "330-533-7532",
    "phone2": "",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 7,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200058,
    "address": "6635 Covington Cove",
    "name1": "Andrew & Marissa Mickley",
    "name2": "",
    "email1": "amickley@live.com",
    "email2": "mlm775@hotmail.com",
    "phone1": "330-286-3216",
    "phone2": "",
    "memberStatus": "lapsed",
    "isMember": false,
    "paid_2024": true,
    "paid_2025": false,
    "paidYears": [
      2015,
      2016,
      2024
    ],
    "mostRecentYear": 2024,
    "yearsParticipated": 3,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200059,
    "address": "6636 Covington Cove",
    "name1": "Emad & Nabila Baky",
    "name2": "",
    "email1": "emshaba@yahoo.com",
    "email2": "",
    "phone1": "330-720-4155",
    "phone2": "3305189697.0",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2005,
      2006,
      2007,
      2008,
      2009,
      2010,
      2011,
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 18,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200060,
    "address": "6637 Covington Cove",
    "name1": "Jim & Kristin Chahine",
    "name2": "",
    "email1": "james745i@aol.com",
    "email2": "nikodi2@aol.com",
    "phone1": "501-358-1162",
    "phone2": "561-427-5960",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 7,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200061,
    "address": "6638 Covington Cove",
    "name1": "Douglas & Allyn Mckay",
    "name2": "",
    "email1": "dougmckayjr@gmail.com",
    "email2": "allynlisa@gmail.com",
    "phone1": "310-876-4306",
    "phone2": "805-236-6972",
    "memberStatus": "lapsed",
    "isMember": false,
    "paid_2024": false,
    "paid_2025": false,
    "paidYears": [
      2021,
      2022,
      2023
    ],
    "mostRecentYear": 2023,
    "yearsParticipated": 3,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200062,
    "address": "6639 Covington Cove",
    "name1": "Urwa & Haya Barakat",
    "name2": "",
    "email1": "URWA1@AOL.COM",
    "email2": "",
    "phone1": "330-559-2398",
    "phone2": "",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2005,
      2006,
      2007,
      2008,
      2009,
      2011,
      2012,
      2013,
      2014,
      2015,
      2019,
      2020,
      2021,
      2022,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 16,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200063,
    "address": "6702 Covington Cove",
    "name1": "Shawn & Lisa Baxter",
    "name2": "",
    "email1": "lbaxter39@yahoo.com",
    "email2": "",
    "phone1": "",
    "phone2": "",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2012,
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 12,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200064,
    "address": "6768 Covington Cove",
    "name1": "Joel & Maureen Matthews",
    "name2": "",
    "email1": "joel.d.matthews@ampf.com",
    "email2": "",
    "phone1": "330-518-5661",
    "phone2": "",
    "memberStatus": "lapsed",
    "isMember": false,
    "paid_2024": true,
    "paid_2025": false,
    "paidYears": [
      2010,
      2012,
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024
    ],
    "mostRecentYear": 2024,
    "yearsParticipated": 12,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200065,
    "address": "7002 Southberry Hill",
    "name1": "Raymond and Kris Martin",
    "name2": "",
    "email1": "rmartin@npointe.com",
    "email2": "nd4marisa@aol.com",
    "phone1": "216-402-9209",
    "phone2": "440-821-1868",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 10,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200066,
    "address": "7003 Southberry Hill",
    "name1": "Danny & Carol Sankovic",
    "name2": "",
    "email1": "ccdpr4@gmail.com",
    "email2": "",
    "phone1": "330-651-5822",
    "phone2": "330-717-9495",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2005,
      2006,
      2007,
      2008,
      2009,
      2010,
      2011,
      2012,
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 19,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200067,
    "address": "7004 Southberry Hill",
    "name1": "Judy Pallante",
    "name2": "",
    "email1": "judypallante16@gmail.com",
    "email2": "",
    "phone1": "330-360-5666",
    "phone2": "330-360-0412",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2005,
      2006,
      2007,
      2008,
      2009,
      2010,
      2011,
      2012,
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 19,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200068,
    "address": "7005 Southberry Hill",
    "name1": "Stephen & Patricia Pantalone",
    "name2": "",
    "email1": "stephenjpants@gmail.com",
    "email2": "pegallo8191@aol.com",
    "phone1": "330-727-2358",
    "phone2": "330-503-9679",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2005,
      2006,
      2007,
      2008,
      2009,
      2010,
      2012,
      2013,
      2014,
      2015,
      2016,
      2019,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 15,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200069,
    "address": "7006 Southberry Hill",
    "name1": "Eric and Jennifer Clarke",
    "name2": "",
    "email1": "eclarke200@gmail.com",
    "email2": "jjclarke777@gmail.com",
    "phone1": "330-805-8453",
    "phone2": "234-567-7029",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 5,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200070,
    "address": "7007 Southberry Hill",
    "name1": "Timothy & Debra Carney",
    "name2": "",
    "email1": "debc@zoominternet.net",
    "email2": "",
    "phone1": "330-550-6111",
    "phone2": "",
    "memberStatus": "lapsed",
    "isMember": false,
    "paid_2024": true,
    "paid_2025": false,
    "paidYears": [
      2006,
      2007,
      2008,
      2009,
      2010,
      2011,
      2012,
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024
    ],
    "mostRecentYear": 2024,
    "yearsParticipated": 17,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200071,
    "address": "7008 Southberry Hill",
    "name1": "Jeff & Betsy Ahlquist",
    "name2": "",
    "email1": "jeff.ahlquist18@gmail.com",
    "email2": "bkahlquist@gmail.com",
    "phone1": "330-881-4815",
    "phone2": "330-881-4793",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 10,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200072,
    "address": "7009 Southberry Hill",
    "name1": "Tom & Becky Nentwick",
    "name2": "",
    "email1": "tom@extrusionsupplies.com",
    "email2": "",
    "phone1": "330-506-9291",
    "phone2": "330-502-9291",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2005,
      2006,
      2007,
      2008,
      2009,
      2010,
      2011,
      2012,
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 19,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200073,
    "address": "7010 Southberry Hill",
    "name1": "Robert & Jillene Daloise",
    "name2": "",
    "email1": "jillenemd@gmail.com",
    "email2": "",
    "phone1": "330-774-5481",
    "phone2": "330-559-9018",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2005,
      2006,
      2007,
      2010,
      2011,
      2012,
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 17,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200074,
    "address": "7011 Southberry Hill",
    "name1": "John & Kathy Progar",
    "name2": "",
    "email1": "j.progar@zoominternet.net",
    "email2": "jprog@zoominternet.net",
    "phone1": "330-519-7407",
    "phone2": "330-519-7408",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2005,
      2006,
      2007,
      2008,
      2009,
      2010,
      2011,
      2012,
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 19,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200075,
    "address": "7012 Southberry Hill",
    "name1": "Tony Larocca",
    "name2": "",
    "email1": "larocca@zoominternet.net",
    "email2": "",
    "phone1": "330-702-1214",
    "phone2": "330-233-2283",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2005,
      2006,
      2007,
      2008,
      2009,
      2010,
      2011,
      2012,
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 19,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200076,
    "address": "7013 Southberry Hill",
    "name1": "Edward Petrozzi",
    "name2": "",
    "email1": "epetrozzi@hotmail.com",
    "email2": "",
    "phone1": "740-632-5439",
    "phone2": "330-286-3771",
    "memberStatus": "lapsed",
    "isMember": false,
    "paid_2024": false,
    "paid_2025": false,
    "paidYears": [
      2023
    ],
    "mostRecentYear": 2023,
    "yearsParticipated": 1,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200077,
    "address": "7014 Southberry Hill",
    "name1": "Kevin & Mary Scheetz",
    "name2": "",
    "email1": "mb.scheetz@gmail.com",
    "email2": "kevin1scheetz@gmail.com",
    "phone1": "",
    "phone2": "",
    "memberStatus": "lapsed",
    "isMember": false,
    "paid_2024": false,
    "paid_2025": false,
    "paidYears": [
      2005,
      2006,
      2007,
      2008,
      2009,
      2010,
      2011,
      2012,
      2013,
      2014,
      2015,
      2019,
      2020,
      2021
    ],
    "mostRecentYear": 2021,
    "yearsParticipated": 14,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200078,
    "address": "7015 Southberry Hill",
    "name1": "Jeff & Pam Patterson",
    "name2": "",
    "email1": "jpatterson519@yahoo.com",
    "email2": "",
    "phone1": "330-417-4044",
    "phone2": "",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2005,
      2006,
      2007,
      2008,
      2009,
      2010,
      2012,
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 18,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200079,
    "address": "7016 Southberry Hill",
    "name1": "Laurie L. Stephens",
    "name2": "",
    "email1": "laurielee43@zoominternet.net",
    "email2": "",
    "phone1": "330-360-4294",
    "phone2": "",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2005,
      2007,
      2008,
      2009,
      2010,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 15,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200080,
    "address": "7017 Southberry Hill",
    "name1": "Ryan & Michelle Toolson",
    "name2": "",
    "email1": "mick8503@hotmail.com",
    "email2": "",
    "phone1": "330-506-8343",
    "phone2": "",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 6,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200081,
    "address": "7018 Southberry Hill",
    "name1": "Dominic & Kerry J. Prologo",
    "name2": "",
    "email1": "av1911@zoominternet.net",
    "email2": "",
    "phone1": "330-719-8266",
    "phone2": "",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2005,
      2007,
      2008,
      2009,
      2010,
      2011,
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 17,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200082,
    "address": "7019 Southberry Hill",
    "name1": "Theodore & Jennifer Arnold",
    "name2": "",
    "email1": "",
    "email2": "",
    "phone1": "310-428-5311",
    "phone2": "",
    "memberStatus": "lapsed",
    "isMember": false,
    "paid_2024": false,
    "paid_2025": false,
    "paidYears": [
      2005,
      2006,
      2007,
      2008,
      2009,
      2010,
      2011,
      2012,
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2022,
      2023
    ],
    "mostRecentYear": 2023,
    "yearsParticipated": 16,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200083,
    "address": "7020 Southberry Hill",
    "name1": "Randy & Zelda Dinunzio",
    "name2": "",
    "email1": "vinstwo@gmail.com",
    "email2": "",
    "phone1": "330-518-5113",
    "phone2": "330-518-1882",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2005,
      2006,
      2007,
      2008,
      2009,
      2010,
      2011,
      2013,
      2014,
      2015,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 18,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200084,
    "address": "7021 Southberry Hill",
    "name1": "Jamie & Denise Dietz",
    "name2": "",
    "email1": "jDietz@fandrlaw.com",
    "email2": "ddietz@zoominternet.net",
    "phone1": "330-717-9215",
    "phone2": "330-717-9214",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2005,
      2006,
      2007,
      2008,
      2009,
      2010,
      2011,
      2012,
      2013,
      2014,
      2016,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 18,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  },
  {
    "id": 1704067200085,
    "address": "7022 Southberry Hill",
    "name1": "Steve & Katie Swain",
    "name2": "",
    "email1": "swain.october.3@gmail.com",
    "email2": "",
    "phone1": "330-559-4570",
    "phone2": "330-651-4341",
    "memberStatus": "active",
    "isMember": true,
    "paid_2024": true,
    "paid_2025": true,
    "paidYears": [
      2005,
      2006,
      2007,
      2008,
      2009,
      2010,
      2011,
      2019,
      2020,
      2021,
      2022,
      2023,
      2024,
      2025
    ],
    "mostRecentYear": 2025,
    "yearsParticipated": 14,
    "outreachSequence": [],
    "createdAt": "2025-01-01T00:00:00.000Z",
    "source": "directory_import"
  }
];

async function seedIfEmpty() {
  const r = await pool.query("SELECT COUNT(*) FROM residents");
  if (parseInt(r.rows[0].count) === 0) {
    console.log(`Seeding ${SEED_RESIDENTS.length} residents...`);
    for (const res of SEED_RESIDENTS) await dbUpsertOne(res);
    console.log("Seed complete");
  }
}

// ─── Gmail ──────────────────────────────────────────────────────────────────────
function getMailer() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
  });
}

async function sendEmail({ to, subject, html }) {
  const recipient = resolveEmail(to);
  if (isDryRun()) {
    console.log(`[DRY RUN] Email to ${recipient}: ${subject}`);
    return;
  }
  try {
    await getMailer().sendMail({
      from: `"Covington Creek HOA" <${process.env.GMAIL_USER}>`,
      to: recipient, subject,
      html: isTestMode() ? `<div style="background:#fff3cd;padding:10px;margin-bottom:10px"><strong>TEST MODE</strong> — would have gone to: ${to}</div>${html}` : html
    });
    console.log(`Email sent to ${recipient}: ${subject}`);
  } catch(e) { console.error(`Email error to ${recipient}:`, e.message); }
}

// ─── Twilio SMS ─────────────────────────────────────────────────────────────────
async function sendSMS({ to, body }) {
  const phone = resolvePhone(to);
  if (!phone) {
    if (isDryRun()) console.log(`[DRY RUN] SMS to ${to}: ${body}`);
    return;
  }
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return;
  try {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await client.messages.create({ body, from: process.env.TWILIO_PHONE_NUMBER, to: phone });
    console.log(`SMS sent to ${phone}`);
  } catch(e) { console.error(`SMS error to ${phone}:`, e.message); }
}

async function notify({ email, phone, subject, html, sms }) {
  const promises = [];
  if (email) promises.push(sendEmail({ to: email, subject, html }));
  if (phone && sms) promises.push(sendSMS({ to: phone, body: sms }));
  await Promise.allSettled(promises);
}

// ─── PayPal ─────────────────────────────────────────────────────────────────────
async function getPayPalToken() {
  const { id, secret } = getPayPalCreds();
  const creds = Buffer.from(`${id}:${secret}`).toString("base64");
  const res = await fetch(`${getPayPalBase()}/v1/oauth2/token`, {
    method: "POST",
    headers: { "Authorization": `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials"
  });
  const data = await res.json();
  return data.access_token;
}

async function createAndSendInvoice({ recipientEmail, recipientName, address, year, amount }) {
  const token = await getPayPalToken();
  const invoiceNum = `CC-HOA-${year}-${address.replace(/\s+/g,"-").toUpperCase().slice(0,20)}`;

  const createRes = await fetch(`${getPayPalBase()}/v2/invoicing/invoices`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      detail: {
        invoice_number: invoiceNum,
        invoice_date: new Date().toISOString().split("T")[0],
        currency_code: "USD",
        note: `Thank you for supporting Covington Creek! This invoice covers your ${year} HOA membership dues.`,
      },
      invoicer: {
        name: { given_name: "Covington Creek", surname: "HOA" },
        email_address: process.env.GMAIL_USER,
      },
      primary_recipients: [{
        billing_info: { name: { full_name: recipientName }, email_address: recipientEmail },
        shipping_info: { name: { full_name: recipientName }, address: {
          address_line_1: address, admin_area_2: "Canfield",
          admin_area_1: "OH", postal_code: "44406", country_code: "US"
        }}
      }],
      items: [{
        name: `${year} HOA Membership Dues`,
        description: "Annual voluntary membership dues — Covington Creek Homeowners Association",
        quantity: "1",
        unit_amount: { currency_code: "USD", value: String(amount) },
        unit_of_measure: "AMOUNT",
      }],
    })
  });

  const invoice = await createRes.json();
  const invoiceId = invoice.id || (invoice.href && invoice.href.split("/").pop());
  if (!invoiceId) { console.error("Invoice creation failed:", JSON.stringify(invoice)); return null; }

  await fetch(`${getPayPalBase()}/v2/invoicing/invoices/${invoiceId}/send`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ send_to_invoicer: false, send_to_recipient: true })
  });

  if (isDryRun()) console.log(`[DRY RUN] Invoice ${invoiceId} would have been sent to ${recipientEmail}`);
  else console.log(`Invoice sent to ${recipientEmail} for ${address}`);
  return invoiceId;
}

// ─── Email + SMS templates ──────────────────────────────────────────────────────
const PAYPAL_ME = "covingtoncreek.hoa96";

const templates = {
  welcome: (name, address, isMember, dues) => ({
    subject: `Welcome to Covington Creek, ${name.split(" ")[0]}!`,
    html: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#333">
      <h2 style="color:#2c4a1e">Covington Creek Homeowners Association</h2>
      <p>Dear ${name},</p>
      <p>Welcome to the neighborhood! Your contact information has been added to our directory.</p>
      ${isMember ? `<p>You'll receive a PayPal invoice shortly for your ${YEAR} dues of $${dues}. You can also pay anytime at <a href="https://paypal.me/${PAYPAL_ME}/${dues}" style="color:#2c4a1e">paypal.me/${PAYPAL_ME}/${dues}</a>.</p>` : `<p>If you'd like to join the association anytime, it's just $${dues}/year — reply to this email or visit our form.</p>`}
      <p>Join our Facebook group: <strong>"Covington Creek Neighbors"</strong></p>
      <p style="margin-top:32px">Warmly,<br/><strong>Betsy Ahlquist</strong><br/>President, Covington Creek HOA</p>
    </div>`,
    sms: `Welcome to Covington Creek! Your info is saved. ${isMember ? `Invoice for $${dues} dues coming shortly.` : `Questions? Email ${process.env.GMAIL_USER}`}`,
  }),

  paymentConfirmation: (name, address, year, amount) => ({
    subject: `Payment received — Covington Creek HOA ${year} Dues`,
    html: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#333">
      <h2 style="color:#2c4a1e">Covington Creek HOA — Payment Confirmed</h2>
      <p>Dear ${name},</p>
      <p>Thank you! Your ${year} HOA dues of <strong>$${amount}</strong> have been received.</p>
      <div style="background:#f5f2eb;border-radius:8px;padding:16px;margin:20px 0;font-size:14px">
        <strong>Address:</strong> ${address}<br/>
        <strong>Year:</strong> ${year}<br/>
        <strong>Amount:</strong> $${amount}.00<br/>
        <strong>Status:</strong> ✓ Paid
      </div>
      <p>Thank you for supporting our neighborhood!</p>
      <p style="margin-top:32px"><strong>Brenda Wise</strong><br/>Treasurer, Covington Creek HOA</p>
    </div>`,
    sms: `Covington Creek HOA: Payment of $${amount} received for ${year}. Thank you! 🌿`,
  }),

  duesInvoice: (name, address, year, amount) => ({
    subject: `${year} Covington Creek HOA Dues — $${amount} Invoice`,
    html: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#333">
      <h2 style="color:#2c4a1e">Covington Creek Homeowners Association</h2>
      <p>Dear ${name},</p>
      <p>Your ${year} HOA dues invoice for <strong>$${amount}</strong> has been sent via PayPal.</p>
      <p><a href="https://paypal.me/${PAYPAL_ME}/${amount}" style="display:inline-block;background:#2c4a1e;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none">Pay $${amount} via PayPal →</a></p>
      <p>Or by check to <strong>Covington Creek Homeowners Association</strong><br/>Mail to: Brenda Wise, 6622 Covington CV, Canfield OH 44406</p>
      <p><strong>Please remit by June 15th.</strong></p>
      <p style="margin-top:32px"><strong>Betsy Ahlquist</strong><br/>President, Covington Creek HOA</p>
    </div>`,
    sms: `Covington Creek HOA: Your $${amount} dues invoice for ${year} is ready. Pay at paypal.me/${PAYPAL_ME}/${amount} or by check. Due June 15th.`,
  }),

  memberReminder: (name, year, amount, isLast, deadline) => ({
    subject: `${isLast ? "Final reminder" : "Reminder"}: ${year} HOA dues${isLast ? ` — close ${deadline}` : ""}`,
    html: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#333">
      <h2 style="color:#2c4a1e">Covington Creek HOA</h2>
      <p>Dear ${name},</p>
      <p>${isLast ? `This is our final reminder — dues close <strong>${deadline}</strong>.` : "A friendly reminder that your HOA dues are still outstanding."} Amount due: <strong>$${amount}</strong>.</p>
      <p><a href="https://paypal.me/${PAYPAL_ME}/${amount}" style="color:#2c4a1e">Pay via PayPal →</a> or check to Brenda Wise, 6622 Covington CV, Canfield OH 44406.</p>
      <p>Thank you!<br/><strong>Betsy Ahlquist</strong></p>
    </div>`,
    sms: `Covington Creek HOA: ${isLast ? `Final reminder — $${amount} dues close ${deadline}.` : `Friendly reminder: $${amount} dues still outstanding.`} Pay: paypal.me/${PAYPAL_ME}/${amount}`,
  }),

  touch1: (address, amount) => ({
    subject: `Your neighborhood needs you — Covington Creek HOA ${YEAR}`,
    html: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#333">
      <h2 style="color:#2c4a1e">Covington Creek Homeowners Association</h2>
      <p>Dear Neighbor,</p>
      <p>We hope you're enjoying the neighborhood! Last year your neighbors' dues paid for:</p>
      <ul style="line-height:2.2">
        <li>Lawn mowing, fertilizer &amp; landscaping — <strong>$3,405</strong></li>
        <li>Holiday banners &amp; seasonal decorations — <strong>$2,541</strong></li>
        <li>Holiday lighting — <strong>$1,770</strong></li>
        <li>Neighborhood electricity &amp; upkeep — <strong>$1,954</strong></li>
      </ul>
      <p>Membership is <strong>completely voluntary</strong> and dues are just <strong>$${amount}/year</strong>.</p>
      <p><a href="${process.env.FRONTEND_URL}?form=1&addr=${encodeURIComponent(address)}" style="display:inline-block;background:#2c4a1e;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none">Join the association →</a></p>
      <p style="margin-top:32px">Warmly,<br/><strong>Betsy Ahlquist</strong><br/>President, Covington Creek HOA</p>
    </div>`,
    sms: `Covington Creek HOA: We'd love to have you as a member! Dues are just $${amount}/yr and support neighborhood upkeep. Join: ${process.env.FRONTEND_URL}?form=1`,
  }),

  touch2: (address, paidCount, total, amount) => ({
    subject: `${paidCount} of your ${total} neighbors have joined — Covington Creek HOA`,
    html: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#333">
      <h2 style="color:#2c4a1e">Covington Creek HOA</h2>
      <p>Dear Neighbor,</p>
      <p><strong>${paidCount} of your ${total} Covington Creek neighbors</strong> have already joined the association this year. Their $${amount}/year supports the lawn care, decorations, and community upkeep that benefits all of us.</p>
      <p><a href="${process.env.FRONTEND_URL}?form=1&addr=${encodeURIComponent(address)}" style="display:inline-block;background:#2c4a1e;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none">Join now →</a></p>
      <p>Thank you,<br/><strong>Betsy Ahlquist</strong></p>
    </div>`,
    sms: `Covington Creek HOA: ${paidCount} of ${total} neighbors have joined this year. Add your support for just $${amount}: ${process.env.FRONTEND_URL}?form=1`,
  }),

  touch3: (address, amount, deadline) => ({
    subject: `Last chance: Covington Creek HOA dues close ${deadline}`,
    html: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#333">
      <h2 style="color:#2c4a1e">Covington Creek HOA</h2>
      <p>Dear Neighbor,</p>
      <p>This is our final note for the year — dues close <strong>${deadline}</strong>. Your $${amount} directly funds the landscaping, decorations, and upkeep that benefits all of Covington Creek.</p>
      <p><a href="${process.env.FRONTEND_URL}?form=1&addr=${encodeURIComponent(address)}" style="color:#2c4a1e">Join before ${deadline} →</a></p>
      <p>No hard feelings if now is not the right time — the invitation is always open.</p>
      <p>Warmly,<br/><strong>Betsy Ahlquist</strong></p>
    </div>`,
    sms: `Covington Creek HOA: Last chance — dues close ${deadline}. Join for $${amount}: ${process.env.FRONTEND_URL}?form=1`,
  }),

  boardSummary: (label, data) => ({
    subject: `Covington Creek HOA — ${label}`,
    html: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#333">
      <h2 style="color:#2c4a1e">HOA Automation Summary</h2>
      <p style="color:#888;font-size:13px">${label} · ${new Date().toLocaleDateString()} ${isTestMode() ? "· <strong style=\"color:orange\">TEST MODE</strong>" : ""}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        ${Object.entries(data).map(([k,v])=>`<tr><td style="padding:8px 0;color:#666;border-bottom:1px solid #eee">${k}</td><td style="padding:8px 0;font-weight:bold;color:#2c4a1e;border-bottom:1px solid #eee;text-align:right">${v}</td></tr>`).join("")}
      </table>
    </div>`,
  }),
};

// ─── API Routes ─────────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ ok: true, testMode: isTestMode(), time: new Date().toISOString() }));

app.get("/api/residents", async (_, res) => {
  try { res.json(await dbRead()); } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/residents", async (req, res) => {
  try {
    const data = req.body;
    if (!data.address) return res.status(400).json({ error: "Address required" });
    const residents = await dbRead();
    const idx = residents.findIndex(r => r.address?.toLowerCase() === data.address?.toLowerCase());
    const now = new Date().toISOString();
    let resident;
    if (idx >= 0) {
      resident = { ...residents[idx], ...data, updatedAt: now };
    } else {
      resident = { ...data, id: Date.now(), createdAt: now, outreachSequence: [] };
    }
    await dbUpsertOne(resident);
    res.json({ ok: true, resident });

    // Fire automations async
    setImmediate(async () => {
      try {
        const sched = await getSchedule();
        const dues = sched.duesAmount || 120;
        const name = data.name1 || "Neighbor";

        // Welcome notification
        if (data.email1) {
          const tpl = templates.welcome(name, data.address, data.isMember, dues);
          await notify({ email: data.email1, phone: data.phone1, subject: tpl.subject, html: tpl.html, sms: tpl.sms });
        }

        // PayPal invoice if member
        if (data.isMember && data.email1) {
          const invoiceId = await createAndSendInvoice({
            recipientEmail: data.email1,
            recipientName: `${data.name1}${data.name2 ? " & "+data.name2 : ""}`,
            address: data.address, year: sched.year || YEAR, amount: dues,
          });
          if (invoiceId) {
            const r = { ...resident, paypalInvoiceId: invoiceId };
            await dbUpsertOne(r);
            // Also send our custom email + SMS with PayPal link
            const tpl = templates.duesInvoice(name, data.address, sched.year || YEAR, dues);
            await notify({ email: data.email1, phone: data.phone1, subject: tpl.subject, html: tpl.html, sms: tpl.sms });
          }
        }

        // Board notification
        const boardTpl = templates.boardSummary("New resident registration", {
          "Name": `${data.name1}${data.name2?" & "+data.name2:""}`,
          "Address": data.address,
          "Email": data.email1 || "Not provided",
          "Phone": data.phone1 || "Not provided",
          "Joined": data.isMember ? `Yes — $${dues} invoice sent` : "No",
          "Mode": isTestMode() ? "TEST" : "LIVE",
          "Registered": now,
        });
        await sendEmail({ to: sched.boardEmail || process.env.BOARD_EMAIL, subject: boardTpl.subject, html: boardTpl.html });
      } catch(e) { console.error("Post-registration automation error:", e.message); }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Mark paid (check payments)
app.post("/api/residents/:id/paid", async (req, res) => {
  try {
    const residents = await dbRead();
    const r = residents.find(r => String(r.id) === req.params.id);
    if (!r) return res.status(404).json({ error: "Not found" });
    const year = req.body.year || YEAR;
    r[`paid_${year}`] = true;
    r.paidAt = new Date().toISOString();
    r.paymentMethod = req.body.method || "check";
    await dbUpsertOne(r);

    // Add to ledger
    await addLedgerEntry({
      id: `income-${r.id}-${year}`,
      date: new Date().toISOString().split("T")[0],
      description: `${year} dues — ${r.name1} (${r.address})`,
      amount: req.body.amount || 120,
      category: "dues",
      source: req.body.method || "check",
      residentId: r.id,
      year,
    });

    // Send confirmation
    if (r.email1) {
      const sched = await getSchedule();
      const tpl = templates.paymentConfirmation(r.name1, r.address, year, req.body.amount || sched.duesAmount || 120);
      await notify({ email: r.email1, phone: r.phone1, subject: tpl.subject, html: tpl.html, sms: tpl.sms });
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get/save schedule
app.get("/api/schedule", async (_, res) => {
  try { res.json(await getSchedule()); } catch { res.json(DEFAULT_SCHEDULE); }
});
app.post("/api/schedule", async (req, res) => {
  try {
    await pool.query(
      "INSERT INTO settings (key, data) VALUES ('schedule', $1) ON CONFLICT (key) DO UPDATE SET data = $1, updated_at = NOW()",
      [JSON.stringify(req.body)]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get/save test mode config
app.get("/api/testmode", async (_, res) => {
  try {
    const r = await pool.query("SELECT data FROM settings WHERE key = 'testmode' LIMIT 1");
    res.json(r.rows[0]?.data || { enabled: false });
  } catch { res.json({ enabled: false }); }
});
app.post("/api/testmode", async (req, res) => {
  try {
    await pool.query(
      "INSERT INTO settings (key, data) VALUES ('testmode', $1) ON CONFLICT (key) DO UPDATE SET data = $1, updated_at = NOW()",
      [JSON.stringify(req.body)]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get/save ledger
app.get("/api/ledger", async (_, res) => {
  try { res.json(await getLedger()); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/ledger", async (req, res) => {
  try {
    const entry = { ...req.body, id: req.body.id || `entry-${Date.now()}` };
    await addLedgerEntry(entry);
    res.json({ ok: true, entry });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Import bank CSV
app.post("/api/ledger/import-csv", async (req, res) => {
  try {
    const { rows } = req.body; // array of parsed CSV rows
    let imported = 0;
    for (const row of rows) {
      const entry = {
        id: `bank-${row.date}-${Math.abs(row.amount)}-${imported}`,
        date: row.date,
        description: row.description,
        amount: Math.abs(row.amount),
        category: row.amount < 0 ? "expense" : "income",
        source: "bank_csv",
        raw: row,
      };
      await addLedgerEntry(entry);
      imported++;
    }
    res.json({ ok: true, imported });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PayPal webhook
app.post("/webhooks/paypal", async (req, res) => {
  try {
    const event = req.body;
    console.log("PayPal webhook:", event.event_type);

    if (event.event_type === "INVOICING.INVOICE.PAID") {
      const recipientEmail = event.resource?.primary_recipients?.[0]?.billing_info?.email_address;
      const invoiceId = event.resource?.id;
      const amountPaid = parseFloat(event.resource?.amount?.value || 0);

      const residents = await dbRead();
      let resident = residents.find(r => r.paypalInvoiceId === invoiceId);
      if (!resident && recipientEmail) {
        resident = residents.find(r =>
          r.email1?.toLowerCase() === recipientEmail?.toLowerCase() ||
          r.email2?.toLowerCase() === recipientEmail?.toLowerCase()
        );
      }

      if (resident) {
        const sched = await getSchedule();
        const year = sched.year || YEAR;
        resident[`paid_${year}`] = true;
        resident.paidAt = new Date().toISOString();
        resident.paypalInvoiceId = invoiceId;
        await dbUpsertOne(resident);

        // Add to ledger
        await addLedgerEntry({
          id: `paypal-${invoiceId}`,
          date: new Date().toISOString().split("T")[0],
          description: `${year} dues — ${resident.name1} (${resident.address})`,
          amount: amountPaid || sched.duesAmount || 120,
          category: "dues",
          source: "paypal",
          residentId: resident.id,
          invoiceId,
          year,
        });

        // Confirmation email + SMS
        if (resident.email1) {
          const tpl = templates.paymentConfirmation(resident.name1, resident.address, year, amountPaid || sched.duesAmount || 120);
          await notify({ email: resident.email1, phone: resident.phone1, subject: tpl.subject, html: tpl.html, sms: tpl.sms });
        }

        // Board notification
        const boardTpl = templates.boardSummary("Payment received via PayPal", {
          "Resident": `${resident.name1}${resident.name2?" & "+resident.name2:""}`,
          "Address": resident.address,
          "Amount": `$${amountPaid || 120}.00`,
          "Invoice ID": invoiceId || "N/A",
          "Mode": isTestMode() ? "TEST" : "LIVE",
        });
        await sendEmail({ to: sched.boardEmail || process.env.BOARD_EMAIL, subject: boardTpl.subject, html: boardTpl.html });

        console.log(`Marked ${resident.address} as paid via PayPal`);
      } else {
        console.warn(`Could not match payment — email: ${recipientEmail}, invoice: ${invoiceId}`);
      }
    }
    res.json({ ok: true });
  } catch(e) { console.error("Webhook error:", e.message); res.status(500).json({ error: e.message }); }
});

// ─── Daily scheduled job (runs at 8am ET, checks against configured dates) ─────
cron.schedule("0 8 * * *", async () => {
  const today = new Date().toISOString().split("T")[0];
  const sched = await getSchedule();
  const DUES = sched.duesAmount || 120;
  const YEAR_S = sched.year || YEAR;
  const residents = await dbRead();
  console.log(`CRON daily check: ${today} (test mode: ${isTestMode()})`);

  // ── Invoice send day ──────────────────────────────────────────────────────────
  if (today === sched.invoiceSendDate) {
    const members = residents.filter(r => (r.memberStatus==="active"||r.memberStatus==="lapsed") && r.email1);
    const outreach = residents.filter(r => ["never_joined","dormant","new_owner"].includes(r.memberStatus) && r.email1);
    let invoiced = 0, touched = 0;

    for (const r of members) {
      try {
        const invoiceId = await createAndSendInvoice({ recipientEmail: r.email1, recipientName: `${r.name1}${r.name2?" & "+r.name2:""}`, address: r.address, year: YEAR_S, amount: DUES });
        if (invoiceId) { r.paypalInvoiceId = invoiceId; r[`paid_${YEAR_S}`] = false; await dbUpsertOne(r); }
        const tpl = templates.duesInvoice(r.name1, r.address, YEAR_S, DUES);
        await notify({ email: r.email1, phone: r.phone1, subject: tpl.subject, html: tpl.html, sms: tpl.sms });
        invoiced++;
        await new Promise(res => setTimeout(res, 400));
      } catch(e) { console.error(`Invoice error ${r.address}:`, e.message); }
    }

    for (const r of outreach) {
      try {
        const tpl = templates.touch1(r.address, DUES);
        await notify({ email: r.email1, phone: r.phone1, subject: tpl.subject, html: tpl.html, sms: tpl.sms });
        if (!r.outreachSequence) r.outreachSequence = [];
        r.outreachSequence.push({ type:"nonmember_touch", touchNum:1, sentAt: new Date().toISOString() });
        await dbUpsertOne(r);
        touched++;
        await new Promise(res => setTimeout(res, 300));
      } catch(e) { console.error(`Touch 1 error ${r.address}:`, e.message); }
    }

    const bTpl = templates.boardSummary("Dues season kickoff", { "Invoiced": invoiced, "Touch 1 sent": touched, "Amount": `$${DUES}`, "Deadline": sched.dueDeadline, "Mode": isTestMode()?"TEST":"LIVE" });
    await sendEmail({ to: sched.boardEmail || process.env.BOARD_EMAIL, subject: bTpl.subject, html: bTpl.html });
  }

  // ── Member reminder 1 ─────────────────────────────────────────────────────────
  if (today === sched.memberReminder1) {
    const unpaid = residents.filter(r => (r.memberStatus==="active"||r.memberStatus==="lapsed") && r.email1 && !r[`paid_${YEAR_S}`]);
    let sent = 0;
    for (const r of unpaid) {
      try {
        const tpl = templates.memberReminder(r.name1, YEAR_S, DUES, false, sched.dueDeadline);
        await notify({ email: r.email1, phone: r.phone1, subject: tpl.subject, html: tpl.html, sms: tpl.sms });
        sent++;
        await new Promise(res => setTimeout(res, 400));
      } catch(e) { console.error(`Reminder 1 error ${r.address}:`, e.message); }
    }

    // Touch 2 for non-members
    const paidCount = residents.filter(r => r[`paid_${YEAR_S}`]).length;
    const touch2 = residents.filter(r => ["never_joined","dormant","new_owner"].includes(r.memberStatus) && r.email1 && ((r.outreachSequence||[]).filter(e=>e.type==="nonmember_touch").length===1));
    let t2 = 0;
    for (const r of touch2) {
      try {
        const tpl = templates.touch2(r.address, paidCount, 86, DUES);
        await notify({ email: r.email1, phone: r.phone1, subject: tpl.subject, html: tpl.html, sms: tpl.sms });
        r.outreachSequence.push({ type:"nonmember_touch", touchNum:2, sentAt: new Date().toISOString() });
        await dbUpsertOne(r);
        t2++;
        await new Promise(res => setTimeout(res, 300));
      } catch(e) { console.error(`Touch 2 error ${r.address}:`, e.message); }
    }

    const bTpl = templates.boardSummary("Mid-season reminders", { "Member reminders": sent, "Touch 2 sent": t2, "Paid so far": paidCount });
    await sendEmail({ to: sched.boardEmail || process.env.BOARD_EMAIL, subject: bTpl.subject, html: bTpl.html });
  }

  // ── Final reminders ───────────────────────────────────────────────────────────
  if (today === sched.memberReminder2) {
    const unpaid = residents.filter(r => (r.memberStatus==="active"||r.memberStatus==="lapsed") && r.email1 && !r[`paid_${YEAR_S}`]);
    let sent = 0;
    for (const r of unpaid) {
      try {
        const tpl = templates.memberReminder(r.name1, YEAR_S, DUES, true, sched.dueDeadline);
        await notify({ email: r.email1, phone: r.phone1, subject: tpl.subject, html: tpl.html, sms: tpl.sms });
        sent++;
        await new Promise(res => setTimeout(res, 400));
      } catch(e) { console.error(`Final reminder error ${r.address}:`, e.message); }
    }

    // Touch 3
    const touch3 = residents.filter(r => ["never_joined","dormant","new_owner"].includes(r.memberStatus) && r.email1 && ((r.outreachSequence||[]).filter(e=>e.type==="nonmember_touch").length===2));
    let t3 = 0;
    for (const r of touch3) {
      try {
        const tpl = templates.touch3(r.address, DUES, sched.dueDeadline);
        await notify({ email: r.email1, phone: r.phone1, subject: tpl.subject, html: tpl.html, sms: tpl.sms });
        r.outreachSequence.push({ type:"nonmember_touch", touchNum:3, sentAt: new Date().toISOString() });
        await dbUpsertOne(r);
        t3++;
        await new Promise(res => setTimeout(res, 300));
      } catch(e) { console.error(`Touch 3 error ${r.address}:`, e.message); }
    }

    const paidCount = residents.filter(r => r[`paid_${YEAR_S}`]).length;
    const bTpl = templates.boardSummary("Final nudges sent", { "Final reminders": sent, "Touch 3 sent": t3, "Total paid": paidCount });
    await sendEmail({ to: sched.boardEmail || process.env.BOARD_EMAIL, subject: bTpl.subject, html: bTpl.html });
  }

  // ── Weekly board summary (Mondays during dues season) ─────────────────────────
  if (new Date().getDay() === 1 && sched.weeklyBoardUpdate) {
    const invoiceMonth = sched.invoiceSendDate?.slice(5,7);
    const deadlineMonth = sched.dueDeadline?.slice(5,7);
    const currentMonth = today.slice(5,7);
    if (invoiceMonth && deadlineMonth && currentMonth >= invoiceMonth && currentMonth <= deadlineMonth) {
      const members = residents.filter(r => r.memberStatus==="active"||r.memberStatus==="lapsed");
      const paid = members.filter(r => r[`paid_${YEAR_S}`]);
      const pct = members.length ? Math.round((paid.length/members.length)*100) : 0;
      const bTpl = templates.boardSummary("Weekly dues update", {
        "Members": members.length, "Paid": paid.length,
        "Unpaid": members.length-paid.length, "Participation": `${pct}%`,
        "Collected": `$${(paid.length*DUES).toLocaleString()}`,
        "Non-members": residents.filter(r=>["never_joined","dormant","new_owner"].includes(r.memberStatus)).length,
        "Mode": isTestMode()?"TEST":"LIVE",
      });
      await sendEmail({ to: sched.boardEmail || process.env.BOARD_EMAIL, subject: bTpl.subject, html: bTpl.html });
    }
  }
}, { timezone: "America/New_York" });

// ─── Start ──────────────────────────────────────────────────────────────────────
initDB()
  .then(() => seedIfEmpty())
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Covington Creek HOA backend running on port ${PORT}`);
      console.log(`Mode: ${isTestMode() ? "TEST" : "LIVE"}`);
    });
  })
  .catch(e => { console.error("Startup error:", e.message); process.exit(1); });

module.exports = app;
