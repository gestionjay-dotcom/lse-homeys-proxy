function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Variable d'environnement manquante : ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: need("DATABASE_URL"),
  lseToken: need("LSE_TOKEN"),
  homeysBaseUrl: process.env.HOMEYS_BASE_URL ?? "https://api-gateway.homeys.io/api",
  homeysApiKey: need("HOMEYS_API_KEY"),
  homeysUsername: need("HOMEYS_USERNAME"),
  homeysPassword: need("HOMEYS_PASSWORD"),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MIN ?? 15) * 60_000,
  maxWaitMs: Number(process.env.POLL_MAX_HOURS ?? 48) * 3_600_000,
  // Auto-signature par PUT sur la demande de consentement (documenté par Homeys). "false" pour désactiver.
  autoSign: process.env.HOMEYS_AUTOSIGN !== "false",
  bubbleApiToken: process.env.BUBBLE_API_TOKEN ?? "",
  buildingOccupation: process.env.HOMEYS_BUILDING_OCCUPATION ?? "unknown",
  // Si Homeys renvoie des Wh et non des kWh, mettre 1000
  energyDivisor: Number(process.env.HOMEYS_ENERGY_DIVISOR ?? 1),
};
