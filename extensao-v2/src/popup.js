// popup.js v14 — Faro

const $ = id => document.getElementById(id);

// Token da API (servidor com FARO_API_TOKEN). Guardado em chrome.storage.local e enviado só
// nas chamadas /api/ do popup.
let faroApiToken = '';
chrome.storage.local.get(['apiToken'], ({ apiToken }) => {
  faroApiToken = apiToken || '';
  if ($('apiToken')) $('apiToken').value = faroApiToken;
});
const _fetchOriginal = window.fetch.bind(window);
window.fetch = (url, opts = {}) => {
  if (faroApiToken && String(url).includes('/api/')) {
    opts = { ...opts, headers: { ...(opts.headers || {}), 'X-Faro-Token': faroApiToken } };
  }
  return _fetchOriginal(url, opts);
};
document.addEventListener('DOMContentLoaded', () => {
  const el = $('apiToken');
  if (el) el.addEventListener('change', () => {
    faroApiToken = el.value.trim();
    chrome.storage.local.set({ apiToken: faroApiToken });
  });
});

function setStatus(msg, type = '') {
  $('statusMsg').textContent = msg;
  $('statusMsg').className = 'status ' + type;
}

let currentMode = 'session';
function setMode(mode) {
  currentMode = mode;
  $('tab-session').className = 'mode-tab' + (mode === 'session' ? ' active' : '');
  $('tab-flow').className    = 'mode-tab' + (mode === 'flow'    ? ' active' : '');
  $('session-mode').classList.toggle('hidden', mode !== 'session');
  $('flow-mode').classList.toggle('hidden',    mode !== 'flow');
  setStatus('');
}

function showPanel(name) {
  ['setup', 'recording', 'save'].forEach(p => {
    $(`${p}-panel`).classList.add('hidden');
  });
  $(`${name}-panel`).classList.remove('hidden');
  $('dot').className = 'dot' + (name === 'recording' ? ' active' : '');
}

function showFlowPanel(name) {
  ['flow-setup', 'flow-recording', 'flow-save'].forEach(p => {
    $(`${p}-panel`).classList.add('hidden');
  });
  $(`${name}-panel`).classList.remove('hidden');
  $('dot').className = 'dot' + (name === 'flow-recording' ? ' recording' : '');
}

// ─── EXTRAI PARAMS DO GTM PREVIEW ─────────────────────────────────────────────
function extrairGtmPreview(url) {
  if (!url) return null;
  try {
    const hash = url.includes('#') ? url.split('#')[1] : '';
    const hashParams = new URLSearchParams(hash.replace(/^\/?/, '').replace(/^\/\?/, ''));
    const base = url.split('#')[0];
    const u = new URL(base.includes('://') ? base : 'https://x.com?' + base);

    const gtm_auth    = u.searchParams.get('gtm_auth')    || hashParams.get('gtm_auth')    || null;
    const gtm_preview = u.searchParams.get('gtm_preview') || hashParams.get('gtm_preview') || null;
    const gtm_cookies_win = u.searchParams.get('gtm_cookies_win') || hashParams.get('gtm_cookies_win') || 'x';

    if (!gtm_auth || !gtm_preview) return null;
    return { gtm_auth, gtm_preview, gtm_cookies_win };
  } catch { return null; }
}

// ─── TUDO dentro do DOMContentLoaded ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  // Tabs
  $('tab-session').addEventListener('click', () => setMode('session'));
  $('tab-flow').addEventListener('click',    () => setMode('flow'));

  // ─── VERIFICA ATUALIZAÇÃO ──────────────────────────────────────────────────
  chrome.storage.local.get(['serverUrl'], async ({ serverUrl }) => {
    if (!serverUrl) return;
    try {
      const resp = await fetch(`${serverUrl}/api/extensao/versao`);
      if (!resp.ok) return;
      const { versao, downloadUrl } = await resp.json();
      const manifest = chrome.runtime.getManifest();
      if (versao && versao !== manifest.version) {
        const div = document.createElement('div');
        div.style.cssText = 'background:#1d4ed8;color:#fff;padding:10px 12px;border-radius:8px;margin-bottom:12px;font-size:11px;';
        div.innerHTML = `
          <div style="font-weight:700;margin-bottom:4px">🔔 Nova versão v${versao}</div>
          <div style="opacity:.85;margin-bottom:6px">Você está na v${manifest.version}</div>
          <a href="${serverUrl}${downloadUrl}" style="display:inline-block;background:#fff;color:#1d4ed8;padding:4px 10px;border-radius:6px;font-weight:700;font-size:11px;text-decoration:none">⬇️ Baixar</a>
        `;
        document.body.insertBefore(div, document.body.firstChild);
      }
    } catch {}
  });

// ─── RESTAURA ESTADO ───────────────────────────────────────────────────────
  chrome.storage.local.get(['serverUrl', 'sgtmDomain', 'flowServerUrl', 'flowMarca', 'flowSgtmDomain'], (data) => {
    if (data.serverUrl)        $('serverUrl').value        = data.serverUrl;
    if (data.sgtmDomain)       $('sgtmDomain').value       = data.sgtmDomain;

    if (data.flowServerUrl)    $('flowServerUrl').value    = data.flowServerUrl;
    if (data.flowMarca)        $('flowMarca').value        = data.flowMarca;
    if (data.flowSgtmDomain)   $('flowSgtmDomain').value  = data.flowSgtmDomain;

  });

  chrome.runtime.sendMessage({ type: 'GET_SESSION' }, (s) => {
    if (s?.active) {
      showPanel('recording');
      $('dlCount').textContent  = s.dlEvents?.length  ?? 0;
      $('ga4Count').textContent = s.ga4Events?.length ?? 0;
    } else if (s?.dlEvents?.length > 0 || s?.ga4Events?.length > 0) {
      showPanel('save');
    } else {
      showPanel('setup');
    }
  });

  chrome.runtime.sendMessage({ type: 'GET_FLOW_SESSION' }, (s) => {
    if (s?.active) {
      setMode('flow');
      showFlowPanel('flow-recording');
      $('flowActionCount').textContent = s.actions?.length   ?? 0;
      $('flowDlCount').textContent     = s.dlEvents?.length  ?? 0;
      $('flowGa4Count').textContent    = s.ga4Events?.length ?? 0;
    }
  });

  // Atualiza contadores
  setInterval(() => {
    chrome.runtime.sendMessage({ type: 'GET_SESSION' }, (s) => {
      if (s?.active) {
        $('dlCount').textContent  = s.dlEvents?.length  ?? 0;
        $('ga4Count').textContent = s.ga4Events?.length ?? 0;
      }
    });
    chrome.runtime.sendMessage({ type: 'GET_FLOW_SESSION' }, (s) => {
      if (s?.active) {
        $('flowActionCount').textContent = s.actions?.length   ?? 0;
        $('flowDlCount').textContent     = s.dlEvents?.length  ?? 0;
        $('flowGa4Count').textContent    = s.ga4Events?.length ?? 0;
      }
    });
    // Parceiros: lê direto da página via window.__parceirosCapture
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab?.id) return;
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world:  'MAIN',
        func:   () => window.__parceirosCapture?.length ?? 0,
      }).then(res => {
        const n = res?.[0]?.result ?? 0;
        const el = document.getElementById('parceirosCount');
        if (el) el.textContent = n;
      }).catch(() => {});
    });
  }, 800);

  // ─── SESSÃO: INICIAR ────────────────────────────────────────────────────────
  $('btnStart').addEventListener('click', async () => {
    const serverUrl     = $('serverUrl').value.trim().replace(/\/$/, '');
    const sgtmDomain    = $('sgtmDomain').value.trim();
    if (!serverUrl) { setStatus('URL do servidor é obrigatória', 'err'); return; }

    chrome.storage.local.set({ serverUrl, sgtmDomain });
    try {
      await fetch(`${serverUrl}/api/cancel-recording`, { method: 'POST' }).catch(() => {});
      const resp = await fetch(`${serverUrl}/api/start-recording`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: '' }),
      });
      if (!resp.ok) throw new Error(await resp.text());
    } catch (e) { setStatus('Erro ao conectar: ' + e.message, 'err'); return; }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.runtime.sendMessage({ type: 'START_SESSION', serverUrl, sgtmDomain, startUrl: tab?.url ?? '', tabId: tab?.id });
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'START_CAPTURE', sgtmDomain, tabId: tab.id }).catch(() => {});
    showPanel('recording');
    setStatus('', '');
  });

  // ─── SESSÃO: PARAR ─────────────────────────────────────────────────────────
  $('btnStop').addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'STOP_CAPTURE' }).catch(() => {});
    });
    chrome.runtime.sendMessage({ type: 'STOP_SESSION' }, () => { showPanel('save'); setStatus(''); });
  });

  $('btnCancel').addEventListener('click', async () => {
    chrome.runtime.sendMessage({ type: 'GET_SESSION' }, async (s) => {
      if (s?.serverUrl) fetch(`${s.serverUrl}/api/cancel-recording`, { method: 'POST' }).catch(() => {});
      chrome.runtime.sendMessage({ type: 'CLEAR_SESSION' });
      showPanel('setup'); setStatus('Captura cancelada');
    });
  });

  $('btnDiscard').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'CLEAR_SESSION' });
    showPanel('setup'); setStatus('Sessão descartada');
  });

  $('btnSave').addEventListener('click', async () => {
    const nome     = $('nomeSessao').value.trim();
    const marca    = $('marcaSessao').value.trim().toLowerCase();
    const testador = $('testador').value.trim() || 'Não informado';
    if (!nome || !marca) { setStatus('Preencha nome e marca', 'err'); return; }
    chrome.runtime.sendMessage({ type: 'GET_SESSION' }, async (s) => {
      if (!s?.serverUrl) { setStatus('Servidor não configurado', 'err'); return; }
      setStatus('Salvando...');
      // Lê parceiros direto da página no momento de salvar
      let parceiros = [];
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
          const res = await chrome.scripting.executeScript({
            target: { tabId: tab.id }, world: 'MAIN',
            func: () => JSON.parse(JSON.stringify(window.__parceirosCapture ?? [])),
          });
          if (res?.[0]?.result?.length) parceiros = res[0].result;
        }
      } catch {}
      try {
        const resp = await fetch(`${s.serverUrl}/api/save-session`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ marca, nome, testador, dlEvents: s.dlEvents, ga4Events: s.ga4Events, startUrl: s.startUrl, parceiros }),
        });
        let data;
        try { data = await resp.json(); } catch { throw new Error(`Servidor retornou resposta invalida (HTTP ${resp.status})`); }
        if (!resp.ok) throw new Error(data?.error ?? `Erro HTTP ${resp.status}`);
        chrome.runtime.sendMessage({ type: 'CLEAR_SESSION' });
        showPanel('setup'); setStatus(`✅ "${nome}" salvo!`, 'ok');
      } catch (e) { setStatus('Erro: ' + e.message, 'err'); }
    });
  });

  // ─── FLUXO: INICIAR ────────────────────────────────────────────────────────
  $('btnStartFlow').addEventListener('click', async () => {
    const serverUrl        = $('flowServerUrl').value.trim().replace(/\/$/, '');
    const marca            = $('flowMarca').value.trim().toLowerCase();
    const sgtmDomain       = $('flowSgtmDomain').value.trim();
    if (!serverUrl || !marca) { setStatus('URL e marca são obrigatórios', 'err'); return; }

    chrome.storage.local.set({ flowServerUrl: serverUrl, flowMarca: marca, flowSgtmDomain: sgtmDomain });

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.runtime.sendMessage({
      type: 'START_FLOW_SESSION', serverUrl, sgtmDomain, marca,
      startUrl: tab?.url ?? '', tabId: tab?.id,
    });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'START_FLOW_CAPTURE', sgtmDomain }).catch(() => {});
    }
    showFlowPanel('flow-recording');
    setStatus('', '');
  });

  // ─── FLUXO: PARAR ──────────────────────────────────────────────────────────
  $('btnStopFlow').addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'STOP_FLOW_CAPTURE' }).catch(() => {});
    });
    chrome.runtime.sendMessage({ type: 'STOP_FLOW_SESSION' }, () => {
      showFlowPanel('flow-save'); setStatus('');
    });
  });

  $('btnCancelFlow').addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'STOP_FLOW_CAPTURE' }).catch(() => {});
    });
    chrome.runtime.sendMessage({ type: 'CLEAR_FLOW_SESSION' });
    showFlowPanel('flow-setup'); setStatus('Gravação cancelada');
  });

  $('btnDiscardFlow').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'CLEAR_FLOW_SESSION' });
    showFlowPanel('flow-setup'); setStatus('Fluxo descartado');
  });

  // ─── FLUXO: SALVAR ─────────────────────────────────────────────────────────
  $('btnSaveFlow').addEventListener('click', async () => {
    const nome = $('flowNome').value.trim();
    if (!nome) { setStatus('Preencha o nome do fluxo', 'err'); return; }

    chrome.runtime.sendMessage({ type: 'GET_FLOW_SESSION' }, async (s) => {
      if (!s?.serverUrl) { setStatus('Servidor não configurado', 'err'); return; }
      setStatus('Salvando fluxo...');
      try {
        const resp = await fetch(`${s.serverUrl}/api/save-flow`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            nome, marca: s.marca, sgtmDomain: s.sgtmDomain,
            startUrl: s.startUrl, actions: s.actions,
            dlEvents: s.dlEvents, ga4Events: s.ga4Events,
          }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error);
        chrome.runtime.sendMessage({ type: 'CLEAR_FLOW_SESSION' });
        showFlowPanel('flow-setup');
        setStatus(`✅ Fluxo "${nome}" salvo!`, 'ok');
      } catch (e) { setStatus('Erro: ' + e.message, 'err'); }
    });
  });

}); // fim DOMContentLoaded
