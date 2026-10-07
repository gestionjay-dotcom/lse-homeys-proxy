import express, { NextFunction, Request, Response } from "express";
import { config } from "./config";
import { getCollecte, initDb, insertCollecte } from "./db";
import { getDailyRaw, testConnexion } from "./homeys";
import { startWorker } from "./worker";

const app = express();
app.use(express.json({ limit: "1mb" }));

// Santé (sans secret) : utile pour vérifier que le service est en ligne
app.get("/health", (_req, res) => res.json({ ok: true }));

// Toutes les autres routes exigent le secret partagé avec Bubble
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.header("x-lse-token") !== config.lseToken) return res.status(401).json({ erreur: "x-lse-token invalide" });
  next();
});

// Test de la connexion à Homeys (login + liste des bâtiments)
app.get("/homeys/test", async (_req, res) => {
  try { res.json(await testConnexion()); }
  catch (e: any) { res.status(502).json({ erreur: e.message, detail: e.body ?? null }); }
});

// Diagnostic : toutes les variables journalières d'une source (7 derniers jours par défaut)
app.get("/homeys/debug/daily/:idSource", async (req, res) => {
  try {
    const au = String(req.query.au ?? new Date().toISOString().slice(0, 10));
    const du = String(req.query.du ?? new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10));
    res.json(await getDailyRaw(req.params.idSource, du, au));
  } catch (e: any) { res.status(502).json({ erreur: e.message, detail: e.body ?? null }); }
});

// Lancer une collecte
app.post("/homeys/collecte", async (req, res) => {
  const b = req.body ?? {};
  const manquants: string[] = [];
  if (!b.collecte_id) manquants.push("collecte_id");
  if (!/^\d{14}$/.test(String(b.pdl ?? ""))) manquants.push("pdl (14 chiffres)");
  for (const k of ["prenom", "nom", "email"]) if (!b.signataire?.[k]) manquants.push(`signataire.${k}`);
  for (const k of ["rue", "cp", "ville"]) if (!b.adresse?.[k]) manquants.push(`adresse.${k}`);
  if (!b.raison_sociale) manquants.push("raison_sociale");
  if (!b.callback_url) manquants.push("callback_url");
  if (manquants.length) return res.status(400).json({ erreur: "Champs manquants ou invalides", champs: manquants });

  const existante = await getCollecte(b.collecte_id);
  if (existante) return res.status(202).json({ collecte_id: b.collecte_id, statut: existante.statut });

  await insertCollecte(b.collecte_id, String(b.pdl), { ...b, historique_mois: b.historique_mois ?? 12 });
  res.status(202).json({ collecte_id: b.collecte_id, statut: "en_cours" });
});

// Suivre une collecte
app.get("/homeys/collecte/:id", async (req, res) => {
  const c = await getCollecte(req.params.id);
  if (!c) return res.status(404).json({ erreur: "Collecte inconnue" });
  res.json({ collecte_id: c.collecte_id, statut: c.statut, etape: c.etape, erreur: c.erreur, resultat: c.resultat, homeys: c.homeys });
});

(async () => {
  await initDb();
  startWorker();
  app.listen(config.port, () => console.log(`Proxy LSE-Homeys démarré sur le port ${config.port}`));
})().catch((e) => { console.error(e); process.exit(1); });
