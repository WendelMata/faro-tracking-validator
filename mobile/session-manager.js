const activeSessions = new Map();

function startSession(sessionId, marca, platform, nome, pasta, appVersion) {
  activeSessions.set(sessionId, {
    marca,
    platform: platform || 'android',
    startTime: Date.now(),
    rawEvents: [],
    nome: nome || null,
    pasta: pasta || null,
    appVersion: appVersion || null,
    currentRegion: null,
  });
}

// Nível C (specs/param-value-validation/03-nivel-c-contexto-tela.md) — atualizada a cada
// screen_view reconhecido; ausente até o primeiro, diferente da marca, que nasce presente.
function updateScreenContext(sessionId, region) {
  const session = activeSessions.get(sessionId);
  if (session) session.currentRegion = region;
}

function pushEvent(sessionId, eventData) {
  if (activeSessions.has(sessionId)) {
    activeSessions.get(sessionId).rawEvents.push(eventData);
  }
}

function finalizeSession(sessionId) {
  const session = activeSessions.get(sessionId);
  activeSessions.delete(sessionId);
  return session;
}

function getSession(sessionId) {
  return activeSessions.get(sessionId) || null;
}

function getActiveSessions() {
  return [...activeSessions.entries()].map(([sessionId, s]) => ({
    sessionId,
    marca: s.marca,
    startTime: s.startTime,
    eventCount: s.rawEvents.filter(e => e.type !== 'partner').length,
    nome: s.nome || null,
  }));
}

module.exports = { startSession, pushEvent, finalizeSession, getActiveSessions, getSession, updateScreenContext };
