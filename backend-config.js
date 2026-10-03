// Account data and access tokens are only sent to this verified HTTPS origin.
const origin = "https://benni-projects.de";
const minimumApiVersion = "1.1.0";
const requiredCapabilities = Object.freeze([
  "auth",
  "clips",
  "uploads",
  "playback",
  "profiles",
  "profileWrite",
  "privateClips",
  "passwordChange",
  "avatars"
]);
const legacyCapabilities = Object.freeze(["auth", "clips", "uploads", "playback"]);
const capabilityLabels = Object.freeze({
  auth: "Anmeldung",
  clips: "Community-Feed",
  uploads: "Clip-Upload",
  playback: "Clip-Wiedergabe",
  profiles: "Profile",
  profileWrite: "Profil- und Datenschutzeinstellungen",
  privateClips: "persönliche Clipbibliothek",
  passwordChange: "Passwortänderung",
  avatars: "Profilbilder"
});

function compareVersions(left, right) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value || ""));
    return match ? match.slice(1).map(Number) : null;
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function inspectHealth(payload) {
  const serverVersion = typeof payload?.version === "string" ? payload.version : null;
  const isClipfarmApi = payload?.ok === true && payload.service === "clipfarm-community-api";
  const declaredCapabilities = Array.isArray(payload?.capabilities)
    ? payload.capabilities.filter((value) => typeof value === "string")
    : null;
  const versionComparison = compareVersions(serverVersion, minimumApiVersion);
  const capabilities = declaredCapabilities || (versionComparison !== null && versionComparison >= 0
    ? [...requiredCapabilities]
    : versionComparison !== null && compareVersions(serverVersion, "1.0.0") >= 0
      ? [...legacyCapabilities]
      : []);
  const missingCapabilities = requiredCapabilities.filter((capability) => !capabilities.includes(capability));
  const coreVersionComparison = compareVersions(serverVersion, "1.0.0");
  const coreAvailable = isClipfarmApi && coreVersionComparison !== null && coreVersionComparison >= 0 &&
    ["auth", "clips", "uploads"].every((capability) => capabilities.includes(capability));
  const outdated = coreAvailable && missingCapabilities.length > 0;
  let message;
  if (!isClipfarmApi) {
    message = "Der Server antwortet, aber die Clipfarm-API wurde nicht bestätigt.";
  } else if (!coreAvailable) {
    message = "Der Server antwortet, aber seine API-Version wird nicht unterstützt.";
  } else if (outdated) {
    const missing = missingCapabilities.map((capability) => capabilityLabels[capability] || capability).join(", ");
    message = `Clipfarm-API v${serverVersion} ist erreichbar; ${missing} fehlen. Dafür ist ein Backend-Update auf v${minimumApiVersion} erforderlich.`;
  } else {
    message = `Clipfarm-API v${serverVersion} ist über HTTPS erreichbar und aktuell.`;
  }
  return {
    apiConfirmed: isClipfarmApi,
    serverVersion,
    capabilities,
    missingCapabilities,
    available: coreAvailable,
    compatible: coreAvailable && missingCapabilities.length === 0,
    outdated,
    minimumApiVersion,
    message
  };
}

function capabilityForEndpoint(route, method = "GET") {
  const path = String(route || "").split("?")[0];
  const verb = String(method || "GET").toUpperCase();
  if (path.startsWith("/auth/")) return "auth";
  if (path === "/profile/password") return "passwordChange";
  if (path === "/profile") return verb === "POST" ? "profileWrite" : "profiles";
  if (/^\/users\/[0-9a-f-]{36}\/avatar$/i.test(path)) return "avatars";
  if (path === "/clips") {
    if (verb === "POST") return "uploads";
    if (verb === "GET" && /(?:^|&)scope=mine(?:&|$)/.test(String(route).split("?")[1] || "")) return "privateClips";
    return "clips";
  }
  if (/^\/clips\/[0-9a-f-]{36}\/media$/i.test(path)) return "playback";
  return null;
}

function unsupportedCapabilityMessage(capability, status) {
  const label = capabilityLabels[capability] || capability;
  const version = status?.serverVersion ? ` v${status.serverVersion}` : "";
  return `Die Clipfarm-API${version} ist erreichbar, unterstützt ${label} aber noch nicht. Bitte den Backend-Server auf mindestens v${minimumApiVersion} aktualisieren.`;
}

module.exports = Object.freeze({
  origin,
  apiBase: origin + "/api/v1",
  healthPath: "/health",
  minimumApiVersion,
  requiredCapabilities,
  inspectHealth,
  capabilityForEndpoint,
  unsupportedCapabilityMessage
});
