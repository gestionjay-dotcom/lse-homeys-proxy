/** Cherche une clé n'importe où dans un JSON (premier résultat trouvé). */
export function deepFind(obj: any, key: string): any {
  if (obj === null || typeof obj !== "object") return undefined;
  if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  for (const v of Object.values(obj)) {
    const r = deepFind(v, key);
    if (r !== undefined) return r;
  }
  return undefined;
}

export type Log = (msg: string, extra?: unknown) => void;

/** Logs en JSON, une ligne par évènement, toujours avec l'id de collecte et le PDL. */
export function makeLog(collecteId: string, pdl: string): Log {
  return (msg, extra) => {
    let e: unknown = extra;
    if (extra !== undefined) {
      const s = typeof extra === "string" ? extra : JSON.stringify(extra);
      e = s && s.length > 3000 ? s.slice(0, 3000) + "…(tronqué)" : extra;
    }
    console.log(JSON.stringify({ t: new Date().toISOString(), collecte_id: collecteId, pdl, msg, extra: e }));
  };
}

export function monthsAgo(n: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
}

/** Erreur "métier" : inutile de réessayer, on passe la collecte en erreur. */
export class BusinessError extends Error {}

/** Minuscules, sans accents ni ponctuation : pour comparer deux adresses. */
export function norm(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

/** Date AAAA-MM-JJ moins n mois, plus 1 jour (donc exactement n mois glissants, bornes incluses). */
export function minusMonths(dateIso: string, n: number): string {
  const d = new Date(dateIso.slice(0, 10) + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() - n);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
