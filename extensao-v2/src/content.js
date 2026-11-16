// content.js v11

(function () {
  const IGNORAR = [
    'gtm.js', 'gtm.click', 'gtm.dom', 'gtm.load', 'gtm.historyChange',
    'gtm.scrollDepth', 'gtm.elementVisibility', 'gtm.formSubmit', 'gtm.pageError',
    'OneTrustLoaded', 'OptanonLoaded', 'OneTrustGroupsUpdated',
    'oppuz:add_to_cart', 'oppuz:view_item', 'virtual_pageview', 'deco',
  ];

  let active     = false;
  let sgtmDomain = '';
  let tabId      = null;

  // ─── BRIDGE em tempo real (eventos futuros) ───────────────────────────────
  let flowActive = false;

  window.addEventListener('message', (evt) => {
    if (!evt.data) return;

    // dataLayer
    if (evt.data.__dlCapture && (active || flowActive)) {
      const item = evt.data.payload;
      if (!item?.event?.event || IGNORAR.includes(item.event.event)) return;
      if (active)     chrome.runtime.sendMessage({ type: 'DL_EVENT',      event: item });
      if (flowActive) chrome.runtime.sendMessage({ type: 'FLOW_DL_EVENT', event: item });
    }

    // GA4 hit real
    if (evt.data.__ga4Hit) {
      const hit = evt.data.hit;
      if (!hit?.event_name) return;
      if (active)     chrome.runtime.sendMessage({ type: 'GA4_HIT_REAL', hit });
      if (flowActive) chrome.runtime.sendMessage({ type: 'FLOW_GA4_HIT', hit });
    }

    // Ações do usuário (cliques, scroll, navegação)
    if (evt.data.__userAction && flowActive) {
      chrome.runtime.sendMessage({ type: 'FLOW_ACTION', action: evt.data.action });
    }

    // Parceiros — captura sempre, independente de sessão ativa
    if (evt.data.__parceiro) {
      const hit = evt.data.hit;
      chrome.runtime.sendMessage({ type: 'PARCEIRO_HIT', hit }).catch(() => {});
      if (flowActive) chrome.runtime.sendMessage({ type: 'FLOW_PARCEIRO_HIT', hit }).catch(() => {});
    }

    // ─── PONTE: dashboard Faro Web pede o estado da captura ao vivo ─────────
    // O dashboard roda como uma página normal (mesma origem que <all_urls>),
    // então recebe este content script também — usa isso pra falar direto
    // com o background.js sem precisar do servidor no meio.
    if (evt.data.source === 'faro-dashboard' && evt.data.type === 'FARO_LIVE_SUBSCRIBE') {
      // Registra esta aba como "dashboard" — só quem se registrar recebe os
      // broadcasts de evento (evita mandar mensagem pra toda aba aberta no
      // navegador a cada disparo, que sobrecarregava o service worker).
      chrome.runtime.sendMessage({ type: 'FARO_REGISTER_LIVE_TAB' }).catch(() => {});
      chrome.runtime.sendMessage({ type: 'GET_SESSION' }, (s) => {
        if (chrome.runtime.lastError) return;
        window.postMessage({
          source: 'faro-extension', type: 'FARO_LIVE_SESSION_STATE',
          active: !!s?.active, events: s?.dlEvents ?? [], startedAt: s?.startedAt ?? null,
        }, '*');
      });
    }
  });

  // ─── GTM PREVIEW ─────────────────────────────────────────────────────────
  // Preview ativado via URL params na navegação (popup.js) — GTM lê na inicialização
  // Aqui apenas reforça os cookies caso a página já esteja carregada
  function ativarGtmPreview(gtmPreview) {
    if (!gtmPreview?.gtm_auth || !gtmPreview?.gtm_preview) return;
    try {
      document.cookie = 'gtm_preview='     + gtmPreview.gtm_preview + ';path=/';
      document.cookie = 'gtm_auth='        + gtmPreview.gtm_auth + ';path=/';
      document.cookie = 'gtm_cookies_win=' + (gtmPreview.gtm_cookies_win || 'x') + ';path=/';
    } catch {}
  }

  // ─── ATIVAR: lê fila acumulada + ativa listener ──────────────────────────
  // Idempotente de propósito: pode ser chamada tanto pela leitura direta do
  // chrome.storage.local (rápida, não depende do service worker) quanto pela
  // resposta do GET_SESSION (mensagem pro background) — a que responder primeiro
  // arma a captura; a outra vira no-op.
  function ativarCaptura(domain, tid, gtmPreview) {
    if (active) return;
    active     = true;
    sgtmDomain = domain;
    tabId      = tid;
    // Ativa preview GTM se fornecido
    if (gtmPreview) ativarGtmPreview(gtmPreview);

    // Envia sgtmDomain para o injector.js (MAIN world) para que
    // sendBeacon e fetch interceptors também capturem hits para o sGTM customizado
    if (domain) {
      window.postMessage({ __faroSetSgtm: true, sgtmDomain: domain }, '*');
    }

    // Lê a fila que o injector.js acumulou desde document_start
    // via chrome.scripting (MAIN world) para acessar window.__captureQueue
    chrome.runtime.sendMessage({ type: 'GET_TAB_ID' }, (res) => {
      const id = res?.tabId ?? tid;
      if (!id) return;

      chrome.scripting.executeScript({
        target: { tabId: id },
        world:  'MAIN',
        func:   () => {
          const q = window.__captureQueue ?? { dl: [], ga4: [] };
          window.__captureQueue = { dl: [], ga4: [] }; // limpa após ler
          return q;
        },
      }).then(results => {
        const q = results?.[0]?.result;
        if (!q) return;

        // Processa DL acumulado
        (q.dl ?? []).forEach(item => {
          if (!item?.event?.event || IGNORAR.includes(item.event.event)) return;
          chrome.runtime.sendMessage({ type: 'DL_EVENT', event: item });
        });

        // Processa GA4 acumulado (formato mb.listen)
        (q.ga4 ?? []).forEach((hit) => {
          if (hit?.event_name) {
            chrome.runtime.sendMessage({ type: 'GA4_HIT_REAL', hit });
          }
        });
      }).catch(() => {});
    });

    iniciarGA4Observer();
  }

  // ─── ESTADO INICIAL ───────────────────────────────────────────────────────
  // Caminho rápido: lê direto do chrome.storage.local, sem passar pelo service
  // worker do background (que em MV3 pode estar suspenso e demorar pra acordar).
  // Achado real: hits de sgtm saindo nos primeiros ~1-2s da página, mais rápido
  // que esse round-trip de mensagem — essa leitura evita esse atraso.
  chrome.storage.local.get(['faroLiveSession'], (data) => {
    if (chrome.runtime.lastError) return;
    if (data.faroLiveSession?.active) ativarCaptura(data.faroLiveSession.sgtmDomain, null, null);
  });
  // Caminho de sempre, mantido como reforço (cobre também o gtmPreview, que não
  // vai pro storage) — se o de cima já armou, essa chamada não faz nada (ver
  // guarda de idempotência em ativarCaptura).
  chrome.runtime.sendMessage({ type: 'GET_SESSION' }, (s) => {
    if (chrome.runtime.lastError) return;
    if (s?.active) ativarCaptura(s.sgtmDomain, s.tabId, s.gtmPreview);
  });
  chrome.runtime.sendMessage({ type: 'GET_FLOW_SESSION' }, (s) => {
    if (chrome.runtime.lastError) return;
    if (s?.active) { flowActive = true; iniciarGA4Observer(); ativarGtmPreview(s.gtmPreview); }
  });

  // ─── MENSAGENS DO POPUP / BACKGROUND ─────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'START_CAPTURE')      ativarCaptura(msg.sgtmDomain, msg.tabId, msg.gtmPreview);
    if (msg.type === 'STOP_CAPTURE')       active = false;
    if (msg.type === 'START_FLOW_CAPTURE') { flowActive = true; iniciarGA4Observer(); ativarGtmPreview(msg.gtmPreview); }
    if (msg.type === 'STOP_FLOW_CAPTURE')  flowActive = false;
    if (msg.type === 'GA4_URL_CAPTURED' && active) parseGA4FromUrl(msg.url);
    // Retransmite pro dashboard Faro Web, se esta aba for ele — inofensivo nas
    // demais abas (o site sendo testado não tem nada escutando essa mensagem)
    if (msg.type === 'FARO_LIVE_BROADCAST') {
      window.postMessage({ source: 'faro-extension', ...msg.payload }, '*');
    }
  });

  // ─── GA4 via PerformanceObserver (backup para hits já no buffer) ──────────
  let ga4Started = false;
  function iniciarGA4Observer() {
    if (ga4Started || typeof PerformanceObserver === 'undefined') return;
    ga4Started = true;
    try {
      const obs = new PerformanceObserver((list) => {
        if (!active || !sgtmDomain) return;
        list.getEntries().forEach(e => {
          if (e.name.includes(sgtmDomain)) parseGA4FromUrl(e.name);
        });
      });
      obs.observe({ type: 'resource', buffered: true });
    } catch {}
  }

  // ─── GA4 URL dedup ────────────────────────────────────────────────────────
  const ga4Seen = new Set();
  function parseGA4FromUrl(url) {
    try {
      const key = url.replace(/[?&]_p=[^&]+/, '').replace(/[?&]_et=[^&]+/, '').slice(0, 300);
      if (ga4Seen.has(key)) return;
      ga4Seen.add(key);
    } catch { return; }

    try {
      const urlObj = new URL(url);
      const params = urlObj.searchParams;
      if (!params.get('en')) return;
      // sGTM roteia GA4, Google Ads e outras tags Google pelo mesmo domínio/formato de
      // hit — só o "tid" diferencia (G- é GA4, AW- é Google Ads, DC- é Floodlight etc).
      // Sem esse filtro um hit de Google Ads com o mesmo event_name (ex: "purchase")
      // é tratado como se fosse o hit de GA4 real, e a validação reporta quase todo
      // campo GA4 como "ausente" nele.
      const tid = params.get('tid');
      if (!tid || !tid.startsWith('G-')) return;

      const parsed = { event_name: params.get('en'), params: {}, items: [] };

      for (const [key, value] of params.entries()) {
        if (key.startsWith('ep.'))  parsed.params[key.slice(3)] = value;
        if (key.startsWith('epn.')) parsed.params[key.slice(4)] = parseFloat(value);
      }
      if (params.has('cu')) parsed.params.currency = params.get('cu');

      let i = 1;
      while (params.has(`pr${i}`)) {
        const raw  = decodeURIComponent(params.get(`pr${i}`));
        const item = parseProductCompact(raw);
        if (item && Object.keys(item).length > 0) parsed.items.push(item);
        i++;
      }

      if (parsed.items.length === 0) delete parsed.items;
      if (Object.keys(parsed.params).length === 0) delete parsed.params;

      parsed._meta = {
        tid:      params.get('tid'),
        page_url: params.get('dl') ? decodeURIComponent(params.get('dl')) : null,
        _s:       params.get('_s'),
      };

      chrome.runtime.sendMessage({ type: 'GA4_HIT', parsed, url });
    } catch {}
  }

  function parseProductCompact(raw) {
    const item = {}, parts = raw.split('~'), customKeys = {};
    parts.forEach(p => {
      const km = p.match(/^k(\d+)(.+)$/), vm = p.match(/^v(\d+)(.+)$/);
      if (km) customKeys[`k${km[1]}`] = decodeURIComponent(km[2]);
      if (vm) customKeys[`v${vm[1]}`] = decodeURIComponent(vm[2]);
    });
    Object.keys(customKeys).forEach(k => {
      if (k.startsWith('k')) {
        const idx = k.slice(1), name = customKeys[`k${idx}`], val = customKeys[`v${idx}`];
        if (name && val !== undefined) item[name] = val;
      }
    });
    for (const p of parts) {
      if      (p.startsWith('lp')) item.list_position = parseInt(p.slice(2));
      else if (p.startsWith('qt')) item.quantity       = parseInt(p.slice(2));
      else if (p.startsWith('id')) item.item_id        = p.slice(2);
      else if (p.startsWith('c2')) item.item_category2 = decodeURIComponent(p.slice(2));
      else if (p.startsWith('pr')) item.price          = parseFloat(p.slice(2));
      else if (p.startsWith('br')) item.item_brand     = decodeURIComponent(p.slice(2));
      else if (p.startsWith('nm')) item.item_name      = decodeURIComponent(p.slice(2));
      else if (p.startsWith('ca')) item.item_category  = decodeURIComponent(p.slice(2));
      else if (p.startsWith('va')) item.item_variant   = decodeURIComponent(p.slice(2));
      else if (p.startsWith('ds')) item.discount       = parseFloat(p.slice(2));
      else if (p.startsWith('ln')) item.item_list_name = decodeURIComponent(p.slice(2));
      else if (p.startsWith('ps')) item.index          = parseInt(p.slice(2));
    }
    return item;
  }
})();
