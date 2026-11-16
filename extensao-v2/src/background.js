// background.js v15 — Faro

let session = {
  active: false, serverUrl: '', sgtmDomain: '',
  dlEvents: [], ga4Events: [], ga4HitMap: {}, startUrl: '', tabId: null,
};

// Espelha o essencial de `session` no chrome.storage.local pra o content.js poder
// se auto-armar direto na injeção (document_start), sem esperar uma mensagem ir e
// voltar pelo service worker do background — que em MV3 pode estar suspenso e
// precisar "acordar", atraso real o bastante pra perder hits de rede que saem nos
// primeiros ~1-2s da página (achado real: sgtm.marca-b.exemplo.com.br/g/collect disparando
// antes até do checkout6-custom.js carregar). chrome.storage não passa pelo
// service worker, então essa leitura não sofre esse atraso.
function sincronizarSessaoNoStorage() {
  chrome.storage.local.set({ faroLiveSession: { active: session.active, sgtmDomain: session.sgtmDomain } });
}

let flowSession = {
  active: false, serverUrl: '', sgtmDomain: '', marca: '',
  startUrl: '', tabId: null,
  actions: [], dlEvents: [], ga4Events: [], ga4HitMap: {},
};

// ─── Seletores estáveis via chrome.scripting (sem banner de debug) ───────────
// Usa executeScript em vez de chrome.debugger — mesma capacidade, sem UI intrusiva

// Gera múltiplos seletores em ordem de prioridade — igual ao Chrome Recorder
// Usa chrome.scripting.executeScript — sem banner de debug, mesma capacidade
async function gerarSeletoresCDP(tabId, x, y) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (pctX, pctY) => {
        const px = Math.round(pctX * window.innerWidth / 100);
        const py = Math.round(pctY * window.innerHeight / 100);
        const el = document.elementFromPoint(px, py);
        if (!el) return null;

        const anchor = el.closest('a[href]');
        const button = el.closest('button');
        const label  = el.closest('label');
        const sem    = anchor || button || label || el;
        const tag    = sem.tagName.toLowerCase();
        const selectors = [];

        // Usa texto do elemento clicado diretamente (não do ancestral semântico)
        // para evitar capturar texto de todo o card (PP\nP\nIncluir...)
        const elText = (el.innerText || el.textContent || '').trim().slice(0, 40);
        const innerText = elText.length > 1 && !elText.includes('\n') ? elText
          : (sem.getAttribute('aria-label') || '').trim().slice(0, 40);
        const role = sem.getAttribute('role') || (tag === 'button' ? 'button' : tag === 'a' ? 'link' : null);

        // 1. ARIA — só usa se o texto for curto e limpo (sem quebras de linha)
        if (role && innerText && innerText.length > 1 && innerText.length < 40
            && !innerText.includes('\n')
            && !['view product','button','link'].includes(innerText.toLowerCase())) {
          selectors.push({ sel: 'aria/' + role + '/' + innerText, tipo: 'aria' });
        }
        const ariaLabel = sem.getAttribute('aria-label');
        if (ariaLabel && !['view product'].includes(ariaLabel)) {
          selectors.push({ sel: '[aria-label="' + ariaLabel + '"]', tipo: 'aria-label' });
        }

        // 2. label[for] — tamanhos VTEX
        if (tag === 'label' && sem.htmlFor) {
          selectors.push({ sel: 'label[for="' + sem.htmlFor + '"]', tipo: 'tamanho' });
        }
        const labelPai = el.closest('label');
        if (labelPai && labelPai.htmlFor && labelPai !== sem) {
          selectors.push({ sel: 'label[for="' + labelPai.htmlFor + '"]', tipo: 'tamanho' });
        }

        // 3. data-item-id — botão de carrinho VTEX
        const itemId = sem.getAttribute('data-item-id') || el.getAttribute('data-item-id');
        if (itemId) selectors.push({ sel: 'button[data-item-id="' + itemId + '"]', tipo: 'carrinho', itemId });

        // 4. data-testid
        const testId = sem.getAttribute('data-testid') || sem.getAttribute('data-test-id');
        if (testId) selectors.push({ sel: '[data-testid="' + testId + '"]', tipo: 'testid' });

        // 5. id único
        if (sem.id && document.querySelectorAll('#' + CSS.escape(sem.id)).length === 1) {
          selectors.push({ sel: '#' + sem.id, tipo: 'id' });
        }

        // 6. href — link/banner/produto
        if (anchor?.href) {
          selectors.push({ sel: null, href: anchor.href, tipo: 'link', text: innerText || null });
        }

        // 7. data-sku
        const sku = sem.getAttribute('data-sku');
        if (sku) selectors.push({ sel: 'button[data-sku="' + sku + '"]', tipo: 'sku' });

        // 8. data-look-dropdown-button
        if (sem.getAttribute('data-look-dropdown-button')) {
          selectors.push({ sel: 'button[data-look-dropdown-button]', tipo: 'dropdown' });
        }

        // 9. Texto do botão — fallback
        if ((tag === 'button' || tag === 'span') && innerText && innerText.length < 50 && innerText.length > 1) {
          selectors.push({ sel: null, tipo: 'texto', text: innerText });
        }

        // data-* relevantes
        const da = {};
        for (const a of sem.attributes) {
          if (a.name.startsWith('data-') && !a.name.includes('gtm') && a.value) {
            da[a.name] = a.value.slice(0, 150);
          }
        }

        // Calcula seletor do card pai para hover — funciona em qualquer site
        let hoverTarget = null;
        if (itemId || tag === 'label') {
          const hoverEl = sem.closest('article, li, [class*="product"], [class*="card"], [class*="item"], [class*="shelf"]');
          if (hoverEl && hoverEl !== document.body) {
            if (hoverEl.id) {
              hoverTarget = '#' + CSS.escape(hoverEl.id);
            } else if (itemId) {
              hoverTarget = ':has(button[data-item-id="' + itemId + '"])';
            } else {
              const siblings = Array.from(hoverEl.parentElement?.children ?? []).filter(c => c.tagName === hoverEl.tagName);
              const idx = siblings.indexOf(hoverEl);
              if (idx >= 0) hoverTarget = hoverEl.tagName.toLowerCase() + ':nth-of-type(' + (idx + 1) + ')';
            }
          }
        }

        // Captura imgSrc da imagem do card pai — usada para hover antes de clicar
        let imgSrc = null;
        if (hoverTarget) {
          const hoverEl = sem.closest('article, li, [class*="product"], [class*="card"], [class*="item"], [class*="shelf"]');
          if (hoverEl) {
            const img = hoverEl.querySelector('img[src]');
            if (img) imgSrc = img.src;
          }
        }
        // Se clicou diretamente em uma img, usa o src dela
        if (!imgSrc && tag === 'img' && sem.src) imgSrc = sem.src;

        return {
          selectors,
          tag,
          href:        anchor?.href ?? null,
          text:        innerText || null,
          itemId:      itemId || null,
          dataAttrs:   Object.keys(da).length > 0 ? da : null,
          hoverTarget: hoverTarget,
          imgSrc:      imgSrc || null,
        };
      },
      args: [x, y], // percentuais — convertidos dentro do func com window.innerWidth/Height
    });

    const data = results?.[0]?.result;
    if (!data) return null;

    const tiposPriority = ['tamanho', 'carrinho', 'testid', 'id', 'aria-label', 'aria', 'link', 'sku', 'dropdown', 'texto'];
    const tipoSel  = data.selectors.find(s => tiposPriority.includes(s.tipo));
    const clickTipo = tipoSel?.tipo ?? (data.href ? 'link' : 'desconhecido');
    const cssPrincipal = data.selectors.find(s => s.sel)?.sel ?? null;

    return {
      cssSelector: cssPrincipal,
      clickTipo,
      href:       data.href,
      text:       data.text,
      itemId:     data.itemId,
      dataAttrs:  data.dataAttrs,
      _selectors: data.selectors,
      _cdp:       true,
    };
  } catch (e) {
    console.warn('[Faro CDP] gerarSeletoresCDP erro:', e?.message ?? e);
    return null;
  }
}

// ─── webRequest: captura hits sGTM ───────────────────────────────────────────
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!session.active || !session.sgtmDomain) return;
    const url = details.url;
    if (!url.includes(session.sgtmDomain)) return;
    if (!url.includes('/g/collect') && !url.includes('en=')) return;
    if (details.tabId && details.tabId > 0) chrome.tabs.sendMessage(details.tabId, { type: 'GA4_URL_CAPTURED', url }).catch(() => {});
  },
  { urls: ['<all_urls>'] },
  []
);


// ─── Interceptação de parceiros por rede ─────────────────────────────────────
// Captura requests de pixel de parceiros diretamente — não depende de SDK timing
const PARTNER_PATTERNS = [
  { pattern: 'facebook.com/tr',         parceiro: 'Meta Pixel' },
  { pattern: 'analytics.tiktok.com',    parceiro: 'TikTok' },
  { pattern: 'ct.pinterest.com',        parceiro: 'Pinterest' },
  { pattern: 'dis.criteo.com',          parceiro: 'Criteo' },
  { pattern: 'rtbhouse.com',            parceiro: 'RTB House' },
  { pattern: 'bat.bing.com',            parceiro: 'Bing Ads' },
  { pattern: 'dito.com.br',             parceiro: 'Dito' },
];

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const url = details.url;
    const match = PARTNER_PATTERNS.find(p => url.includes(p.pattern));
    if (!match) return;

    try {
      const u      = new URL(url);
      const params = {};
      for (const [k, v] of u.searchParams.entries()) params[k] = v;

      // Tenta extrair evento do body (POST) ou URL (GET)
      let evento = params.ev || params.event || params.e || 'hit';
      if (details.requestBody?.formData) {
        const fd = details.requestBody.formData;
        evento = (fd.ev?.[0] || fd.event?.[0] || fd.e?.[0] || evento);
      }

      const hit = {
        parceiro:  match.parceiro,
        evento:    evento,
        payload:   params,
        timestamp: Date.now(),
        url:       details.initiator ?? details.url,
      };

      // Guarda em session e flowSession
      if (!session.parceiros) session.parceiros = [];
      session.parceiros.push(hit);
      if (flowSession.active) {
        if (!flowSession.parceiros) flowSession.parceiros = [];
        flowSession.parceiros.push(hit);
      }
    } catch {}
  },
  { urls: ['<all_urls>'] },
  ['requestBody']
);

// ─── Mensagens ────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // Flow session
  if (msg.type === 'GET_FLOW_SESSION') {
    sendResponse(flowSession);
  } else if (msg.type === 'START_FLOW_SESSION') {
    flowSession = {
      active: true, serverUrl: msg.serverUrl, sgtmDomain: msg.sgtmDomain,
      marca: msg.marca, startUrl: msg.startUrl, tabId: msg.tabId,
      actions: [], dlEvents: [], ga4Events: [], ga4HitMap: {},
      gtmPreview: msg.gtmPreview ?? null,
    };
    if (msg.gtmPreview && msg.startUrl) {
      setGtmPreviewCookies(msg.startUrl, msg.gtmPreview);
    }
    sendResponse({ ok: true });
  } else if (msg.type === 'STOP_FLOW_SESSION') {
    flowSession.active = false;
    sendResponse({ actions: flowSession.actions, dlEvents: flowSession.dlEvents, ga4Events: flowSession.ga4Events, parceiros: flowSession.parceiros ?? [] });
  } else if (msg.type === 'CLEAR_FLOW_SESSION') {
    flowSession = { active: false, serverUrl: '', sgtmDomain: '', marca: '', startUrl: '', tabId: null, actions: [], dlEvents: [], ga4Events: [], ga4HitMap: {} };
    sendResponse({ ok: true });
  } else if (msg.type === 'FLOW_ACTION') {
    if (!flowSession.active) { sendResponse({ ok: false }); return true; }
    const action = msg.action;
    // Enriquece cliques com seletores CDP se disponível
    if (action.type === 'click' && flowSession.tabId && action.x > 0 && action.y > 0) {
      gerarSeletoresCDP(flowSession.tabId, action.x, action.y).then(cdp => {
        if (cdp) {
          action.cssSelector  = cdp.cssSelector  ?? action.cssSelector;
          action.clickTipo    = cdp.clickTipo    ?? action.clickTipo;
          action.href         = cdp.href         ?? action.href;
          action.text         = cdp.text         ?? action.text;
          action.dataAttrs    = cdp.dataAttrs    ?? action.dataAttrs;
          action._selectors   = cdp._selectors   ?? [];
          action._hoverTarget = cdp.hoverTarget  ?? null;
          action.imgSrc       = cdp.imgSrc       ?? action.imgSrc ?? null;
          action._cdp         = true;
          console.log('[Faro CDP] seletores gerados:', cdp._selectors?.length, 'tipo:', cdp.clickTipo);
        } else {
          console.warn('[Faro CDP] sem seletores para clique', action.x, action.y);
        }
        flowSession.actions.push(action);
      }).catch(e => { console.warn('[Faro CDP] catch:', e?.message); flowSession.actions.push(action); });
    } else {
      flowSession.actions.push(action);
    }
    sendResponse({ ok: true });
  } else if (msg.type === 'PARCEIRO_HIT') {
    // Parceiros são capturados sempre — independente de sessão ativa
    if (!session.parceiros) session.parceiros = [];
    session.parceiros.push(msg.hit);
    sendResponse({ ok: true });
  } else if (msg.type === 'FLOW_PARCEIRO_HIT') {
    if (!flowSession.active) { sendResponse({ ok: false }); return true; }
    if (!flowSession.parceiros) flowSession.parceiros = [];
    flowSession.parceiros.push(msg.hit);
    sendResponse({ ok: true });
  } else if (msg.type === 'FLOW_DL_EVENT') {
    if (!flowSession.active) { sendResponse({ ok: false }); return true; }
    flowSession.dlEvents.push(msg.event);
    sendResponse({ ok: true });
  } else if (msg.type === 'FLOW_GA4_HIT') {
    if (!flowSession.active) { sendResponse({ ok: false }); return true; }
    registrarGA4Hit(msg.hit, flowSession);
    sendResponse({ ok: true });

  // Session
  } else if (msg.type === 'GET_TAB_ID') {
    sendResponse({ tabId: session.tabId ?? sender.tab?.id });
  } else if (msg.type === 'GET_SESSION') {
    sendResponse(session);
  } else if (msg.type === 'FARO_REGISTER_LIVE_TAB') {
    if (sender.tab?.id != null) liveDashboardTabs.add(sender.tab.id);
    sendResponse({ ok: true });

// ─── GTM PREVIEW: seta cookies no domínio antes do GTM carregar ──────────────
async function setGtmPreviewCookies(tabUrl, gtmPreview) {
  if (!gtmPreview?.gtm_auth || !gtmPreview?.gtm_preview) return;
  try {
    const domain = new URL(tabUrl).hostname;
    const url    = new URL(tabUrl).origin + '/';
    const base   = { url, path: '/', expirationDate: Date.now()/1000 + 3600 };
    await chrome.cookies.set({ ...base, name: 'gtm_preview',    value: gtmPreview.gtm_preview });
    await chrome.cookies.set({ ...base, name: 'gtm_auth',       value: gtmPreview.gtm_auth });
    await chrome.cookies.set({ ...base, name: 'gtm_cookies_win',value: gtmPreview.gtm_cookies_win || 'x' });
    console.log('[Faro] GTM preview cookies setados para', domain, gtmPreview.gtm_preview);
  } catch (e) {
    console.warn('[Faro] Erro ao setar GTM preview cookies:', e.message);
  }
}

  } else if (msg.type === 'START_SESSION') {
    // Preserva parceiros já capturados antes da sessão iniciar
    const parceirosAnteriores = session.parceiros ?? [];
    session = {
      active: true, serverUrl: msg.serverUrl, sgtmDomain: msg.sgtmDomain,
      dlEvents: [], ga4Events: [], ga4HitMap: {}, startUrl: msg.startUrl, tabId: msg.tabId,
      parceiros: parceirosAnteriores, gtmPreview: msg.gtmPreview ?? null, startedAt: Date.now(),
    };
    // Seta cookies GTM preview antes do GTM carregar
    if (msg.gtmPreview && msg.startUrl) {
      setGtmPreviewCookies(msg.startUrl, msg.gtmPreview);
    }
    sincronizarSessaoNoStorage();
    broadcastLive({ type: 'FARO_LIVE_SESSION_START', startedAt: session.startedAt });
    sendResponse({ ok: true });
  } else if (msg.type === 'STOP_SESSION') {
    session.active = false;
    sincronizarSessaoNoStorage();
    broadcastLive({ type: 'FARO_LIVE_SESSION_STOP' });
    sendResponse({ dlEvents: session.dlEvents, ga4Events: session.ga4Events, parceiros: session.parceiros ?? [] });
  } else if (msg.type === 'CLEAR_SESSION') {
    session = { active: false, serverUrl: '', sgtmDomain: '', dlEvents: [], ga4Events: [], ga4HitMap: {}, startUrl: '', tabId: null };
    sincronizarSessaoNoStorage();
    sendResponse({ ok: true });
  } else if (msg.type === 'DL_EVENT') {
    if (!session.active) { sendResponse({ ok: false }); return true; }
    session.dlEvents.push(msg.event);
    broadcastLive({ type: 'FARO_LIVE_EVENT', event: msg.event });
    sendResponse({ ok: true });
  } else if (msg.type === 'GA4_HIT') {
    if (!session.active) { sendResponse({ ok: false }); return true; }
    registrarGA4Hit(msg.parsed, session);
    sendResponse({ ok: true });
  } else if (msg.type === 'GA4_HIT_REAL') {
    if (!session.active) { sendResponse({ ok: false }); return true; }
    const hit = msg.hit;
    if (!hit?.event_name) { sendResponse({ ok: false }); return true; }
    const key = chaveGA4Hit(hit.event_name, hit.params, hit.timestamp);
    if (!session.ga4HitMap[key]) {
      const entry = { event: hit, timestamp: hit.timestamp, url: hit.url };
      session.ga4HitMap[key] = entry;
      session.ga4Events.push(entry);
    }
    sendResponse({ ok: true });
  }

  return true;
});

// ─── Re-envia capture em cada navegação (SPA) ────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'complete') return;
  if (session.active && (!session.tabId || tabId === session.tabId)) {
    chrome.tabs.sendMessage(tabId, { type: 'START_CAPTURE', sgtmDomain: session.sgtmDomain, tabId }).catch(() => {});
  }
  if (flowSession.active && (!flowSession.tabId || tabId === flowSession.tabId)) {
    chrome.tabs.sendMessage(tabId, { type: 'START_FLOW_CAPTURE', sgtmDomain: flowSession.sgtmDomain }).catch(() => {});
  }
});

// ─── CAPTURA AO VIVO: retransmite só pras abas do dashboard Faro Web ─────────
// Só as abas que já mandaram FARO_REGISTER_LIVE_TAB (o dashboard, ao carregar)
// recebem broadcast — evita fazer chrome.tabs.query({}) + sendMessage em TODAS
// as abas abertas a cada disparo do dataLayer, o que sobrecarregava o service
// worker em sessões com muitos eventos e causava instabilidade na gravação.
const liveDashboardTabs = new Set();

chrome.tabs.onRemoved.addListener((tabId) => liveDashboardTabs.delete(tabId));

function broadcastLive(payload) {
  for (const tabId of liveDashboardTabs) {
    chrome.tabs.sendMessage(tabId, { type: 'FARO_LIVE_BROADCAST', payload }).catch(() => {
      liveDashboardTabs.delete(tabId);
    });
  }
}

// ─── GA4 dedup ────────────────────────────────────────────────────────────────
// Chave preferencial: event_id (o gtag.js gera um por disparo, único mesmo entre
// tags diferentes). Cair pra timestamp em ms só quando não tem event_id — timestamp
// sozinho colide quando duas tags disparam o mesmo event_name no mesmo trigger,
// no mesmo milissegundo (ex: tag de GA4 + tag de afiliado/RAN mandando pro mesmo
// measurement ID): a 2ª chega com a chave igual à 1ª e é descartada como "duplicata",
// mesmo sendo um hit totalmente diferente — achado real com a marca-i.
function chaveGA4Hit(eventName, params, timestamp) {
  const eventId = params?.event_id;
  return eventId ? `${eventName}::${eventId}` : `${eventName}::${timestamp ?? Date.now()}`;
}

function registrarGA4Hit(parsed, sess) {
  sess = sess || session;
  if (!parsed?.event_name) return;
  const key = chaveGA4Hit(parsed.event_name, parsed.params, parsed.timestamp);
  if (!sess.ga4HitMap[key]) {
    const entry = { event: parsed, timestamp: parsed.timestamp ?? Date.now(), url: parsed.url };
    sess.ga4HitMap[key] = entry;
    sess.ga4Events.push(entry);
  }
}
