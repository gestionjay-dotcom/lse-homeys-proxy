import { Pool } from "pg";
import { config } from "./config";

export type Etape =
  | "BATIMENT" | "DOUBLON" | "CONSENT" | "SIGNATURE"
  | "ATTENTE_SOURCE" | "ATTENTE_HISTORIQUE" | "AGREGATS" | "CALLBACK" | "FIN";

export interface HomeysIds {
  id_building?: string;
  id_consentrequest?: string;
  id_source?: string;
  source_preexistante?: boolean;
  sign_url?: string;
  consent_signed?: boolean;
}

export interface Collecte {
  collecte_id: string;
  pdl: string;
  statut: "en_cours" | "termine" | "erreur";
  etape: Etape;
  payload: any;
  homeys: HomeysIds;
  resultat: any | null;
  erreur: string | null;
  callback_tries: number;
  next_run_at: Date;
  created_at: Date;
}

const internal = config.databaseUrl.includes("railway.internal");
export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: internal ? false : { rejectUnauthorized: false },
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS collectes (
      collecte_id    TEXT PRIMARY KEY,
      pdl            TEXT NOT NULL,
      statut         TEXT NOT NULL DEFAULT 'en_cours',
      etape          TEXT NOT NULL DEFAULT 'BATIMENT',
      payload        JSONB NOT NULL,
      homeys         JSONB NOT NULL DEFAULT '{}',
      resultat       JSONB,
      erreur         TEXT,
      callback_tries INT NOT NULL DEFAULT 0,
      next_run_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
}

export async function insertCollecte(id: string, pdl: string, payload: unknown) {
  await pool.query(
    `INSERT INTO collectes (collecte_id, pdl, payload) VALUES ($1,$2,$3)`,
    [id, pdl, JSON.stringify(payload)]
  );
}

export async function getCollecte(id: string): Promise<Collecte | null> {
  const r = await pool.query(`SELECT * FROM collectes WHERE collecte_id=$1`, [id]);
  return r.rows[0] ?? null;
}

export async function dueCollectes(): Promise<Collecte[]> {
  const r = await pool.query(
    `SELECT * FROM collectes WHERE etape <> 'FIN' AND next_run_at <= now() ORDER BY created_at LIMIT 20`
  );
  return r.rows;
}

const JSON_COLS = new Set(["homeys", "resultat", "payload"]);

export async function update(id: string, patch: Partial<Collecte>) {
  const cols: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(patch)) {
    cols.push(`${k}=$${i++}`);
    vals.push(JSON_COLS.has(k) && v !== null ? JSON.stringify(v) : v);
  }
  cols.push("updated_at=now()");
  vals.push(id);
  await pool.query(`UPDATE collectes SET ${cols.join(",")} WHERE collecte_id=$${i}`, vals);
}
