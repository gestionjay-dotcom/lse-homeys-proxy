import { config } from "./config";
import { BusinessError, Log, minusMonths, monthsAgo, norm } from "./util";

export class HomeysError extends Error {
  constructor(public status: number, public body: string, msg: string) {
    super(msg);
  }
}

/* ---------- Connexion (JWT) : un seul login partagé, renouvelé à 23 h ou sur 401 ---------- */

let token: { value: string; expiresAt: number } | null = null;
let loginInFlight: Promise<string> | null = null;

async function getToken(force = false): Promise<string> {
  if (!force && token && Date.now() < token.expiresAt) return token.value;
  if (!loginInFlight) loginInFlight = doLogin().finally(() => { loginInFlight = null; });
  return loginInFlight;
}

async function doLogin(): Promise<string> {
  const res = await fetch(`${config.homeysBaseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": config.homeysApiKey },
    body: JSON.stringify({ username: config.homeysUsername, password: config.homeysPassword }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new HomeysError(res.status, text, `Login Homeys refusé (${res.status})`);
  const value = JSON.parse(text).token; // réponse documentée : { "token": "..." }
  if (!value) throw new Error("Login OK mais champ « token » absent de la réponse");
  token = { value, expiresAt: Date.now() + 23 * 3_600_000 };
  return value;
}

/* ---------- Appel générique avec les deux en-têtes et un rejeu sur 401 ---------- */

type Query = Record<string, string | number | string[] | undefined>;

async function hFetch(method: string, path: string, opts: { query?: Query; body?: unknown } = {}, retried = false): Promise<any> {
  const url = new URL(config.homeysBaseUrl + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
    else url.searchParams.set(k, String(v));
  }
  const jwt = await getToken();
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", "x-api-key": config.homeysApiKey, Authorization: `Bearer ${jwt}` },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401 && !retried) {
    token = null;
    await getToken(true);
    return hFetch(method, path, opts, true);
  }
  const text = await res.text();
  if (!res.ok) throw new HomeysError(res.status, text.slice(0, 600), `${method} ${path} → ${res.status}`);
  try { return JSON.parse(text); } catch { return text; }
}

const asArray = (r: any): any[] => (Array.isArray(r) ? r : Array.isArray(r?.data) ? r.data : []);

/** Routes liste paginées : { data, has_more, next_page }. Plafonné à 10 pages. */
async function listAll(path: string, query: Query): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; page <= 10; page++) {
    const r = await hFetch("GET", path, { query: { ...query, limit: 50, page } });
    out.push(...asArray(r));
    if (!r?.has_more) break;
  }
  return out;
}

/* ---------- Test de connexion ---------- */

export async function testConnexion() {
  const r = await hFetch("GET", "/open/v1/building", { query: { limit: 2 } });
  return { has_more: r?.has_more ?? null, extrait: asArray(r).slice(0, 2).map((b) => ({ _id: b._id, name: b.name, address: b.address })) };
}

/* ---------- Étape 1 : bâtiment ---------- */

const FR = "France";

async function findBuilding(p: any): Promise<string | undefined> {
  const rue = norm(p.adresse.rue);
  const nom = norm(p.raison_sociale ?? "");
  const vus = new Map<string, any>();
  for (const terme of [p.adresse.rue, p.raison_sociale]) {
    if (!terme) continue;
    for (const b of await listAll("/open/v1/building", { search: terme })) vus.set(b._id, b);
  }
  const list = [...vus.values()];
  const memeCp = (b: any) => String(b.address?.zipcode) === String(p.adresse.cp);
  const parRue = list.find((b) => {
    const street = norm(String(b.address?.street ?? ""));
    return memeCp(b) && street !== "" && (street.includes(rue) || rue.includes(street));
  });
  const parNom = nom ? list.find((b) => memeCp(b) && norm(String(b.name ?? "")) === nom) : undefined;
  return (parRue ?? parNom)?._id;
}

export async function findOrCreateBuilding(p: any, log: Log): Promise<string> {
  const existing = await findBuilding(p);
  if (existing) { log("bâtiment existant réutilisé", existing); return existing; }

  const adresse = `${p.adresse.rue} ${p.adresse.cp} ${p.adresse.ville}`;
  const closest = await hFetch("GET", "/open/v1/building/opendata/parcelle/adresse/closest", { query: { address: adresse } });
  const idParcelle: string | undefined = closest?.id_parcelle;
  if (!idParcelle) throw new BusinessError(`Aucune parcelle trouvée à l'adresse « ${adresse} »`);
  log("parcelle la plus proche", { id_parcelle: idParcelle, distance_m: closest.distance });

  const parcelle = await hFetch("GET", "/open/v1/building/opendata/parcelle/buildings", { query: { id_parcelle: idParcelle } });
  const bats: any[] = parcelle?.buildings ?? [];
  if (!bats.length) throw new BusinessError(`Bâtiment BDNB introuvable à l'adresse « ${adresse} » (parcelle ${idParcelle})`);
  log(`${bats.length} bâtiment(s) BDNB sur la parcelle, le premier est retenu`, bats.map((b) => b.id_building));

  // Les 5 premiers caractères d'un id de parcelle cadastrale = code INSEE de la commune
  const citycode = p.adresse.code_insee ?? idParcelle.slice(0, 5);
  const created = await hFetch("POST", "/open/v1/building", {
    body: {
      name: p.raison_sociale,
      address: { street: p.adresse.rue, zipcode: p.adresse.cp, city: p.adresse.ville, country: FR, citycode },
      level: "immeuble",
      occupation: config.buildingOccupation,
      id_building: bats[0].id_building,
    },
  });
  if (!created?._id) throw new Error("Bâtiment créé mais _id absent de la réponse");
  log("bâtiment créé", created._id);
  return created._id;
}

/* ---------- Étape 2 : anti-doublon ---------- */

export async function findSourceByPdl(pdl: string): Promise<string | undefined> {
  const list = await listAll("/open/v1/source", { search: pdl });
  return list.find((s) => String(s.idsource) === pdl)?._id; // la recherche est large : on exige le PDL exact
}

/* ---------- Étape 3 : demande de consentement ---------- */

export async function createConsentRequest(p: any, idBuilding: string) {
  const adresse = { street: p.adresse.rue, zipcode: p.adresse.cp, city: p.adresse.ville, country: FR };
  const pro = Boolean(p.siren);
  const body: any = {
    user: { firstname: p.signataire.prenom, lastname: p.signataire.nom, username: p.signataire.email, isPro: pro },
    consentrequest: [{ idsource: p.pdl, idtype: "pdl", address: adresse, date_from_data: monthsAgo(p.historique_mois ?? 12), _id_building: idBuilding }],
  };
  // company au niveau racine selon le schéma OpenAPI (le guide la montre dans "user" : voir README si erreur 4xx)
  if (pro) {
    body.company = { idcompany: String(p.siren), idtype: "siren", type: "entreprise", name: p.raison_sociale, address: adresse };
  }
  const r = await hFetch("POST", "/open/v1/source/consentrequest", { body });
  return parseConsent(r, p.pdl);
}

function parseConsent(r: any, pdl: string) {
  const unit = (r?.consentrequests ?? []).find((c: any) => c.idsource === pdl) ?? r?.consentrequests?.[0];
  return {
    id: r?._id as string | undefined,
    state: r?.state as string | undefined,
    url: r?.url as string | undefined,
    idSource: unit?._id_source as string | undefined,
    invalids: (r?.invalids ?? []) as { message?: string }[],
    brut: r,
  };
}

/* ---------- Étape 4 : auto-signature = PUT sans corps sur la demande ---------- */

export async function signConsent(idConsentRequest: string, pdl: string) {
  const r = await hFetch("PUT", `/open/v1/source/consentrequest/${idConsentRequest}`);
  return parseConsent(r, pdl);
}

/** Libère le quota de sources si la demande n'a pas été signée (best effort, chemin DELETE supposé). */
export async function deleteConsentRequest(idConsentRequest: string) {
  await hFetch("DELETE", `/open/v1/source/consentrequest/${idConsentRequest}`);
}

/* ---------- Étape 5 : état de la demande ---------- */

export async function getConsent(idConsentRequest: string, pdl: string) {
  return parseConsent(await hFetch("GET", `/open/v1/source/consentrequest/${idConsentRequest}`), pdl);
}

/* ---------- Étape 6 : lecture du contrat ---------- */

export async function getSource(idSource: string) {
  return hFetch("GET", `/open/v2/source/${idSource}`);
}

const POSTE_PUISSANCE: Record<string, string> = { HPH: "HPH", HCH: "HCH", HPE: "HPB", HCE: "HCB", PTE: "PTE" };

export function extractContrat(src: any) {
  const pdl = (src?.data ?? src)?.informations?.pdl ?? {};
  const ps = pdl.structure_tarifaire?.puissance_souscrite_soutirage ?? {};
  const denRaw = ps.denivele ?? ps.denivele_puissance_soutirage ?? null;
  let denivele: Record<string, number> | null = null;
  if (denRaw && typeof denRaw === "object") {
    denivele = {};
    for (const [k, v] of Object.entries(denRaw)) if (typeof v === "number" && POSTE_PUISSANCE[k]) denivele[POSTE_PUISSANCE[k]] = v;
    if (!Object.keys(denivele).length) denivele = null;
  }
  const sout = pdl.data?.soutirage;
  return {
    etat_pdl: pdl.etat as string | undefined,
    historiqueState: pdl.data_retrieval?.historical?.state as string | undefined,
    consentEtat: pdl.consentement?.etat as string | undefined,
    fta: (pdl.structure_tarifaire?.formule_tarifaire_acheminement?.fta ?? null) as string | null,
    segment: (pdl.compteur?.segment ?? null) as string | null,
    calendrier_fournisseur: (pdl.structure_tarifaire?.calendrier_fournisseur?.libelle ?? null) as string | null,
    puissance_kva: (ps.puissance ?? null) as number | null,
    puissances_par_poste_kva: denivele,
    dispo: sout?.date_from ? { du: String(sout.date_from), au: String(sout.date_to) } : null,
  };
}

/* ---------- Étape 7 : kWh par poste (route journalière, sommée par le proxy) ---------- */

// Variables du catalogue Homeys (clé Homeys → poste LSE). À valider au premier test.
const VARIABLES_CONSO: Record<string, string> = {
  HPH: "energie_elec_turpeHPH",
  HCH: "energie_elec_turpeHCH",
  HPB: "energie_elec_turpeHPE",
  HCB: "energie_elec_turpeHCE",
  PTE: "energie_elec_turpePointe",
};
const VARIABLE_TOTAL = "energie_elec_tout";

export function periodeConso(dispo: { du: string; au: string } | null, mois: number) {
  const au = (dispo?.au ?? new Date().toISOString()).slice(0, 10);
  let du = minusMonths(au, mois);
  if (dispo?.du && dispo.du.slice(0, 10) > du) du = dispo.du.slice(0, 10);
  return { du, au };
}

export async function getConsoParPoste(idSource: string, periode: { du: string; au: string }, log: Log) {
  const noms = [...Object.values(VARIABLES_CONSO), VARIABLE_TOTAL];
  const res = await hFetch("GET", "/open/v1/source/data/daily", {
    query: { _id_source: [idSource], date_from: periode.du, date_to: periode.au, variables: noms.map((n) => `${n}.sum`) },
  });
  const rows = asArray(res);
  log(`données journalières : ${rows.length} ligne(s), extrait`, rows.slice(0, 2));
  log("variables présentes dans la 1re ligne", Object.keys(rows[0] ?? {}));

  const somme = (nom: string): number | null => {
    let total = 0, vu = false;
    for (const row of rows) {
      const v = row?.[`${nom}.sum`] ?? row?.[nom]?.sum;
      if (typeof v === "number") { total += v; vu = true; }
    }
    return vu ? Math.round((total / config.energyDivisor) * 10) / 10 : null;
  };

  const out: Record<string, number> = {};
  for (const [poste, nom] of Object.entries(VARIABLES_CONSO)) {
    const s = somme(nom);
    if (s !== null) out[poste] = s;
  }
  if (Object.keys(out).length) return out;
  const total = somme(VARIABLE_TOTAL); // Base : pas de ventilation, on remonte le total
  if (total !== null) return { TOTAL: total };
  log("aucune consommation trouvée sur la période");
  return null;
}

/** Diagnostic : renvoie les premières lignes journalières SANS filtre de variables (toutes celles que Homeys fournit). */
export async function getDailyRaw(idSource: string, du: string, au: string) {
  const res = await hFetch("GET", "/open/v1/source/data/daily", { query: { _id_source: [idSource], date_from: du, date_to: au } });
  const rows = asArray(res);
  return { nb_lignes: rows.length, variables: Object.keys(rows[0] ?? {}), extrait: rows.slice(0, 2) };
}
