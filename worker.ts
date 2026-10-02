import { config } from "./config";
import { Collecte, dueCollectes, update, HomeysIds, Etape } from "./db";
import {
  HomeysError, findOrCreateBuilding, findSourceByPdl, createConsentRequest, signConsent,
  deleteConsentRequest, getConsent, getSource, extractContrat, getConsoParPoste, periodeConso,
} from "./homeys";
import { BusinessError, makeLog, Log } from "./util";

const running = new Set<string>();
const POLL = () => config.pollIntervalMs;
const now = () => new Date();
const inMs = (ms: number) => new Date(Date.now() + ms);

async function goto(c: Collecte, etape: Etape, delayMs = 0, extra: Partial<Collecte> = {}) {
  await update(c.collecte_id, { etape, next_run_at: inMs(delayMs), ...extra });
}

async function fail(c: Collecte, message: string, log: Log) {
  // Une demande non signée occupe du quota Homeys : on la supprime (best effort)
  const h = c.homeys;
  if (h.id_consentrequest && !h.consent_signed) {
    try { await deleteConsentRequest(h.id_consentrequest); log("demande non signée supprimée (quota libéré)", h.id_consentrequest); }
    catch (e) { log("suppression de la demande impossible", String(e)); }
  }
  await update(c.collecte_id, { statut: "erreur", erreur: message, etape: "CALLBACK", next_run_at: now() });
}

function payloadPourBubble(c: Collecte) {
  const r = c.resultat ?? {};
  return {
    collecte_id: c.collecte_id,
    statut: c.statut === "erreur" ? "erreur" : "termine",
    segment: r.segment ?? null,
    fta: r.fta ?? null,
    puissance_kva: r.puissance_kva ?? null,
    puissances_par_poste_kva: r.puissances_par_poste_kva ?? null,
    conso_kwh_par_poste: r.conso_kwh_par_poste ?? null,
    periode: r.periode ?? null,
    calendrier_fournisseur: r.calendrier_fournisseur ?? null,
    homeys: {
      id_source: c.homeys.id_source ?? null,
      id_consentrequest: c.homeys.id_consentrequest ?? null,
      id_building: c.homeys.id_building ?? null,
      source_preexistante: c.homeys.source_preexistante ?? false,
    },
    erreur: c.erreur,
  };
}

async function advance(c: Collecte, log: Log) {
  const p = c.payload;
  const h: HomeysIds = { ...c.homeys };

  switch (c.etape) {
    case "BATIMENT": {
      h.id_building = p.id_building ?? (await findOrCreateBuilding(p, log));
      return goto(c, "DOUBLON", 0, { homeys: h });
    }

    case "DOUBLON": {
      const existing = await findSourceByPdl(c.pdl);
      if (existing) {
        const k = extractContrat(await getSource(existing));
        if (k.consentEtat === "active") {
          log("source existante avec consentement actif : relecture sans nouvelle demande", existing);
          h.id_source = existing;
          h.source_preexistante = true;
          return goto(c, "ATTENTE_HISTORIQUE", 0, { homeys: h });
        }
        log(`source existante mais consentement « ${k.consentEtat} » : nouvelle demande nécessaire`, existing);
      }
      return goto(c, "CONSENT");
    }

    case "CONSENT": {
      const r = await createConsentRequest(p, h.id_building!);
      log("demande de consentement créée", { id: r.id, state: r.state, id_source: r.idSource, invalids: r.invalids });
      if (r.invalids.length) {
        h.id_consentrequest = r.id; // pour que fail() la supprime
        await update(c.collecte_id, { homeys: h });
        throw new BusinessError("Demande refusée par Homeys : " + r.invalids.map((i) => i.message).join(" ; "));
      }
      if (!r.id) throw new BusinessError("Demande créée mais _id absent de la réponse");
      h.id_consentrequest = r.id;
      h.sign_url = r.url;
      if (r.idSource) h.id_source = r.idSource;
      h.consent_signed = false;
      return goto(c, "SIGNATURE", 0, { homeys: h });
    }

    case "SIGNATURE": {
      if (!config.autoSign) {
        log("⚠ SIGNATURE MANUELLE REQUISE (HOMEYS_AUTOSIGN=false). Lien :", h.sign_url);
        return goto(c, "ATTENTE_SOURCE", 60_000);
      }
      const r = await signConsent(h.id_consentrequest!, c.pdl);
      log("consentement signé côté serveur", { state: r.state, id_source: r.idSource });
      if (r.state !== "TERMINATED") return goto(c, "ATTENTE_SOURCE", 60_000);
      h.consent_signed = true;
      if (r.idSource) h.id_source = r.idSource;
      return goto(c, h.id_source ? "ATTENTE_HISTORIQUE" : "ATTENTE_SOURCE", 0, { homeys: h });
    }

    case "ATTENTE_SOURCE": {
      const r = await getConsent(h.id_consentrequest!, c.pdl);
      log("état de la demande", r.state);
      if (r.state !== "TERMINATED") return goto(c, "ATTENTE_SOURCE", POLL());
      h.consent_signed = true;
      h.id_source = r.idSource ?? (await findSourceByPdl(c.pdl));
      if (!h.id_source) return goto(c, "ATTENTE_SOURCE", POLL());
      return goto(c, "ATTENTE_HISTORIQUE", 0, { homeys: h });
    }

    case "ATTENTE_HISTORIQUE": {
      const src = await getSource(h.id_source!);
      const k = extractContrat(src);
      log("état de l'historique", { historique: k.historiqueState, pdl: k.etat_pdl, consentement: k.consentEtat });
      if (k.etat_pdl === "inexistant") throw new BusinessError("PDL inexistant chez Enedis");
      if (k.historiqueState === "noconsent" || k.historiqueState === "crashed") {
        throw new BusinessError(`Récupération de l'historique en échec (état Homeys : ${k.historiqueState})`);
      }
      if (k.historiqueState !== "finished") return goto(c, "ATTENTE_HISTORIQUE", POLL());
      log("contrat lu (réponse brute pour vérifier le mapping)", src);
      const { historiqueState, consentEtat, etat_pdl, ...contrat } = k;
      return goto(c, "AGREGATS", 0, { resultat: contrat });
    }

    case "AGREGATS": {
      const r = c.resultat ?? {};
      const periode = periodeConso(r.dispo ?? null, p.historique_mois ?? 12);
      const conso = await getConsoParPoste(h.id_source!, periode, log);
      const { dispo, ...rest } = r;
      return goto(c, "CALLBACK", 0, { resultat: { ...rest, periode, conso_kwh_par_poste: conso } });
    }

    case "CALLBACK": {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (config.bubbleApiToken) headers.Authorization = `Bearer ${config.bubbleApiToken}`;
      const final = c.statut === "erreur" ? "erreur" : "termine";
      try {
        const res = await fetch(p.callback_url, {
          method: "POST", headers, body: JSON.stringify(payloadPourBubble(c)), signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new Error(`Bubble a répondu ${res.status}`);
        log("callback envoyé à Bubble", { statut: final });
        return goto(c, "FIN", 0, { statut: final });
      } catch (e) {
        const tries = c.callback_tries + 1;
        log(`callback en échec (essai ${tries}/5)`, String(e));
        if (tries >= 5) return goto(c, "FIN", 0, { callback_tries: tries, erreur: (c.erreur ?? "") + " | Callback Bubble impossible après 5 essais" });
        return goto(c, "CALLBACK", 5 * 60_000, { callback_tries: tries });
      }
    }
  }
}

async function processOne(c: Collecte) {
  const log = makeLog(c.collecte_id, c.pdl);
  try {
    const enCours = c.statut === "en_cours" && c.etape !== "CALLBACK";
    if (enCours && Date.now() - new Date(c.created_at).getTime() > config.maxWaitMs) {
      log("délai dépassé", c.etape);
      return await fail(c, `Délai de ${config.maxWaitMs / 3_600_000} h dépassé, collecte bloquée à l'étape ${c.etape}`, log);
    }
    log(`étape ${c.etape}`);
    await advance(c, log);
  } catch (e: any) {
    const detail = e instanceof HomeysError ? `${e.message} ${e.body}` : String(e?.message ?? e);
    log(`erreur à l'étape ${c.etape}`, detail);
    const definitive = e instanceof BusinessError ||
      (e instanceof HomeysError && e.status >= 400 && e.status < 500 && e.status !== 429 && e.status !== 401);
    if (definitive) {
      const fresh = await import("./db").then((m) => m.getCollecte(c.collecte_id));
      await fail(fresh ?? c, `Étape ${c.etape} : ${detail}`, log);
    } else {
      await update(c.collecte_id, { next_run_at: inMs(2 * 60_000) }); // panne temporaire : on réessaie
    }
  }
}

export function startWorker() {
  setInterval(async () => {
    try {
      for (const c of await dueCollectes()) {
        if (running.has(c.collecte_id)) continue;
        running.add(c.collecte_id);
        processOne(c).finally(() => running.delete(c.collecte_id));
      }
    } catch (e) {
      console.error("worker:", e);
    }
  }, 15_000);
  console.log("Worker démarré : reprise automatique des collectes en cours.");
}
