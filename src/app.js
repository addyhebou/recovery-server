import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";

// Reuse one Prisma client across warm serverless invocations.
const prisma = globalThis.__prisma ?? new PrismaClient();
if (!globalThis.__prisma) globalThis.__prisma = prisma;

const PASSWORD = process.env.PASSWORD;
// Signing secret is derived from PASSWORD so there is only one env var to manage.
// Changing PASSWORD logs out every device.
const SECRET = crypto.createHash("sha256").update(`recovery:${PASSWORD ?? ""}`).digest("hex");

// Starting payoff list, used only the first time the database is empty.
const DEFAULT_ITEMS = [
  { title: "Credit card", group: "Past due", amount: 6000, note: "Pay in full. No more minimums." },
  { title: "Gas (past due)", group: "Utilities current", amount: 200 },
  { title: "Electricity (past due)", group: "Utilities current", amount: 800 },
  { title: "Water (past due)", group: "Utilities current", amount: 0, done: true },
  { title: "Parents: first payment", group: "Personal debts", amount: 2000, note: "So they know the plan is real." },
  { title: "Car: down payment", group: "Car", amount: 10000 },
  { title: "Car: pay off remainder", group: "Car", amount: 8000, note: "Confirm no prepayment penalty." },
  { title: "Anjali", group: "Personal debts", amount: 300 },
  { title: "Parents: remaining balance", group: "Personal debts", amount: 6750 },
];

const KINDS = new Set(["paycheck", "stock", "bonus", "side", "expense"]);

export const app = express();

app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN ? process.env.CLIENT_ORIGIN.split(",").map((s) => s.trim()) : true,
  })
);
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.post("/api/login", (req, res) => {
  if (!PASSWORD) return res.status(500).json({ error: "PASSWORD env var is not set on the server." });
  const given = String(req.body?.password ?? "");
  const a = Buffer.from(crypto.createHash("sha256").update(given).digest("hex"));
  const b = Buffer.from(crypto.createHash("sha256").update(PASSWORD).digest("hex"));
  if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "Wrong password." });
  const token = jwt.sign({ sub: "me" }, SECRET, { expiresIn: "60d" });
  res.json({ token });
});

// Everything below requires a valid token.
app.use("/api", (req, res, next) => {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  try {
    jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Not signed in." });
  }
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function listItems() {
  return prisma.planItem.findMany({ orderBy: { position: "asc" } });
}

app.get(
  "/api/state",
  wrap(async (_req, res) => {
    if ((await prisma.planItem.count()) === 0) {
      await prisma.planItem.createMany({
        data: DEFAULT_ITEMS.map((it, i) => ({ ...it, position: i, doneAt: it.done ? new Date() : null })),
      });
    }
    const [settings, items, logs] = await Promise.all([
      prisma.settings.findUnique({ where: { key: "main" } }),
      listItems(),
      prisma.logEntry.findMany({ orderBy: { date: "desc" } }),
    ]);
    res.json({ settings: settings?.data ?? null, items, logs });
  })
);

app.put(
  "/api/settings",
  wrap(async (req, res) => {
    const data = req.body?.data;
    if (!data || typeof data !== "object") return res.status(400).json({ error: "Body must be { data: {...} }" });
    const row = await prisma.settings.upsert({
      where: { key: "main" },
      create: { key: "main", data },
      update: { data },
    });
    res.json({ settings: row.data });
  })
);

function pickItem(body) {
  const out = {};
  if (body.title !== undefined) out.title = String(body.title).slice(0, 200);
  if (body.group !== undefined) out.group = String(body.group).slice(0, 100);
  if (body.note !== undefined) out.note = String(body.note).slice(0, 500);
  if (body.amount !== undefined) out.amount = Math.max(0, Number(body.amount) || 0);
  if (body.paid !== undefined) out.paid = Math.max(0, Number(body.paid) || 0);
  if (body.done !== undefined) {
    out.done = Boolean(body.done);
    out.doneAt = out.done ? new Date() : null;
  }
  return out;
}

app.post(
  "/api/items",
  wrap(async (req, res) => {
    const data = pickItem(req.body ?? {});
    if (!data.title) return res.status(400).json({ error: "title is required" });
    const last = await prisma.planItem.findFirst({ orderBy: { position: "desc" } });
    await prisma.planItem.create({ data: { amount: 0, ...data, position: (last?.position ?? -1) + 1 } });
    res.json({ items: await listItems() });
  })
);

app.patch(
  "/api/items/:id",
  wrap(async (req, res) => {
    await prisma.planItem.update({ where: { id: req.params.id }, data: pickItem(req.body ?? {}) });
    res.json({ items: await listItems() });
  })
);

app.delete(
  "/api/items/:id",
  wrap(async (req, res) => {
    await prisma.planItem.delete({ where: { id: req.params.id } });
    res.json({ items: await listItems() });
  })
);

app.put(
  "/api/items-order",
  wrap(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    await prisma.$transaction(ids.map((id, i) => prisma.planItem.update({ where: { id }, data: { position: i } })));
    res.json({ items: await listItems() });
  })
);

app.post(
  "/api/logs",
  wrap(async (req, res) => {
    const b = req.body ?? {};
    const date = new Date(b.date);
    if (Number.isNaN(date.getTime())) return res.status(400).json({ error: "valid date is required" });
    if (!KINDS.has(b.kind)) return res.status(400).json({ error: `kind must be one of ${[...KINDS].join(", ")}` });
    await prisma.logEntry.create({
      data: {
        date,
        kind: b.kind,
        source: String(b.source ?? "").slice(0, 120),
        amount: Math.max(0, Number(b.amount) || 0),
        note: String(b.note ?? "").slice(0, 500),
      },
    });
    res.json({ logs: await prisma.logEntry.findMany({ orderBy: { date: "desc" } }) });
  })
);

app.delete(
  "/api/logs/:id",
  wrap(async (req, res) => {
    await prisma.logEntry.delete({ where: { id: req.params.id } });
    res.json({ logs: await prisma.logEntry.findMany({ orderBy: { date: "desc" } }) });
  })
);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Server error", detail: err?.message });
});

export default app;
