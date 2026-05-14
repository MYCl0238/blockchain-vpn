import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import { fileURLToPath } from "url";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";

import { dirname } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));

import viewRoutes from "./routes/viewRoutes.js";
import authRoutes from "./routes/authRoutes.js";
import vpnRoutes from "./routes/vpnRoutes.js";
import pool from "./db.js";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SESSION_TABLE = process.env.SESSION_TABLE || "user_sessions";
const SESSION_MAX_AGE_MS = Number(process.env.SESSION_MAX_AGE_MS || 7 * 24 * 60 * 60 * 1000);
const TRUST_PROXY = process.env.TRUST_PROXY === "true";
const SESSION_SECURE_COOKIE = process.env.SESSION_SECURE_COOKIE === "true";
const PgSession = connectPgSimple(session);

if (TRUST_PROXY) {
  app.set("trust proxy", 1);
}

app.use(express.json());
app.use(express.static("public"));
app.use(express.urlencoded({ extended: true }));
app.set("view engine", "ejs");
app.use(cookieParser());

app.use(
  session({
    store: new PgSession({
      pool,
      tableName: SESSION_TABLE,
      createTableIfMissing: true,
    }),
    secret: process.env.SESSION_SECRET || "vpn-secret-key",
    resave: false,
    saveUninitialized: false,
    name: process.env.SESSION_COOKIE_NAME || "vpn_project.sid",
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: SESSION_SECURE_COOKIE,
      maxAge: SESSION_MAX_AGE_MS,
    },
  }),
);

// CORS for the /api/* surface — needed so the Tauri desktop client and the
// React Native mobile client (running off-origin) can call the JSON auth
// endpoints. The EJS views are same-origin so they don't go through this.
const ALLOWED_API_ORIGINS = new Set([
  "tauri://localhost",            // Tauri v2 webview on Linux/macOS
  "https://tauri.localhost",       // Tauri v2 webview on Windows
  "http://localhost:8081",          // Expo web dev server
  "http://localhost:3000",          // Local dev parity
]);
app.use("/api", (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (ALLOWED_API_ORIGINS.has(origin) || origin.startsWith("http://localhost:"))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      req.headers["access-control-request-headers"] || "Content-Type,Accept",
    );
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use("/", viewRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/vpn", vpnRoutes);

app.listen(PORT, () => {
  console.log(`Sunucu http://localhost:${PORT} adresinde çalışıyor...`);
});
