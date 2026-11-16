import { useState, useEffect, useRef } from 'react'
import axios from 'axios'
import HealthOverview from './health/HealthOverview'
import HealthMarca from './health/HealthMarca'

const API = ''

const SIDEBAR_BG   = '#0f1e35'
const SIDEBAR_W    = 220
const ACCENT       = '#2563eb'
const ACCENT_LIGHT = '#e8f0fe'

// Fonte única das cores de status da aba Detalhamento (DATALAYER/GA4 CAPTURADO/
// comparação) — antes cada trecho tinha o próprio hex repetido, o que deixava fácil
// uma cor sair do padrão sem querer. Ainda não são CSS custom properties de verdade
// (o app não importa nenhum arquivo .css com tokens hoje), mas centraliza numa única
// fonte, pronto pra virar `var(--...)` no dia em que isso for conectado.
const STATUS_COLOR = {
  ok:     { fg: '#15803d', bg: '#f0fdf4', border: '#bbf7d0' },
  error:  { fg: '#dc2626', bg: '#fef2f2', border: '#fecaca' },
  warn:   { fg: '#92400e', bg: '#fffbeb', border: '#fde68a' },
  info:   { fg: '#0369a1', bg: '#eff6ff', border: '#bfdbfe' },
  absent: { fg: '#c2410c', bg: '#fff7ed', border: '#fed7aa' },
  alias:  { fg: '#7c3aed', bg: '#faf5ff', border: '#ede9fe' },
  muted:  { fg: '#64748b', bg: '#f8fafc', border: '#e2e8f0' },
}

// ─── PAYLOAD COM ESPAÇO SOBRANDO VISÍVEL ─────────────────────────────────────
// O validador já emite o aviso "espaço sobrando no valor", mas o aviso diz QUAL campo,
// não ONDE: num payload de checkout com 20 campos, um espaço no fim de "Vermelho " é
// literalmente invisível, e o analista teria que conferir caractere a caractere. Aqui o
// espaço ganha fundo âmbar — o mesmo token de warn já usado no resto da tela — e passa a
// ser enxergado sem que o valor seja alterado: a tela continua mostrando o dado cru, que
// numa ferramenta de auditoria não é negociável (trocar o espaço por um glifo "·"
// deixaria o payload bonito e mentiroso).
// O anel de 1px delimita a extensão do trecho, pra distinguir um espaço de dois.
const RE_STRING_JSON = /"(?:[^"\\]|\\.)*"/g;
const ESTILO_ESPACO  = { background: STATUS_COLOR.warn.border, outline: `1px solid ${STATUS_COLOR.warn.fg}`, borderRadius: 2, color: 'inherit' };
const TITULO_ESPACO  = 'Espaço sobrando no valor — no GA4 isso vira um valor de dimensão diferente de "x" sem o espaço';

function PayloadJSON({ data, style }) {
  const bruto = JSON.stringify(data, null, 2);
  const nos = [];
  let cursor = 0, n = 0;

  for (const m of bruto.matchAll(RE_STRING_JSON)) {
    const miolo   = m[0].slice(1, -1);
    const aparado = miolo.trim();
    if (aparado === '' || aparado === miolo) continue; // valor limpo: nada a marcar

    const nInicio = miolo.length - miolo.trimStart().length;
    const nFim    = miolo.length - miolo.trimEnd().length;
    const abre    = m.index + 1;                       // logo depois da aspa de abertura
    const fecha   = m.index + m[0].length - 1;         // logo antes da aspa de fechamento

    nos.push(bruto.slice(cursor, abre));
    if (nInicio) nos.push(<mark key={`ini${n}`} style={ESTILO_ESPACO} title={TITULO_ESPACO}>{miolo.slice(0, nInicio)}</mark>);
    nos.push(miolo.slice(nInicio, miolo.length - nFim));
    if (nFim)    nos.push(<mark key={`fim${n}`} style={ESTILO_ESPACO} title={TITULO_ESPACO}>{miolo.slice(miolo.length - nFim)}</mark>);
    cursor = fecha;
    n++;
  }
  nos.push(bruto.slice(cursor));

  return <pre style={style}>{nos}</pre>;
}

const EVENTO_STATUS = {
  passou:       { icon: '✅', color: STATUS_COLOR.ok.fg },
  falhou:       { icon: '❌', color: STATUS_COLOR.error.fg },
  desconhecido: { icon: '❓', color: STATUS_COLOR.muted.fg },
  ignorado:     { icon: 'ℹ️', color: STATUS_COLOR.info.fg },
  ausente:      { icon: '🚫', color: STATUS_COLOR.absent.fg },
}

// ─── NAV ITEM ─────────────────────────────────────────────────────────────────
function NavItem({ icon, label, active, onClick }) {
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 10, width: '100%',
      padding: '10px 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
      background: active ? 'rgba(37,99,235,0.18)' : 'transparent',
      color: active ? '#93c5fd' : 'rgba(255,255,255,0.68)',
      fontSize: 13, fontWeight: active ? 600 : 400,
      transition: 'all .15s', textAlign: 'left',
    }}>
      <span style={{ display: 'flex' }}>{icon}</span>
      {label}
    </button>
  )
}

// ─── ICON (linha fina, mesmo estilo do Faro App) ──────────────────────────────
const ICON_PATHS = {
  home:     <><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" /></>,
  flows:    <><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" /><line x1="7" y1="2" x2="7" y2="22" /><line x1="17" y1="2" x2="17" y2="22" /><line x1="2" y1="12" x2="22" y2="12" /><line x1="2" y1="7" x2="7" y2="7" /><line x1="2" y1="17" x2="7" y2="17" /><line x1="17" y1="17" x2="22" y2="17" /><line x1="17" y1="7" x2="22" y2="7" /></>,
  activity: <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />,
  puzzle:   <path d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z" />,
  heart:    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />,
  book:     <><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></>,
  tag:      <><path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82Z" /><line x1="7" y1="7" x2="7.01" y2="7" /></>,
  refresh:  <><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></>,
  play:     <polygon points="5 3 19 12 5 21 5 3" />,
  bell:     <><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></>,
  download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></>,
  alert:    <><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></>,
  globe:    <><circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></>,
  phone:    <><rect x="5" y="2" width="14" height="20" rx="2" ry="2" /><line x1="12" y1="18" x2="12.01" y2="18" /></>,
  check:    <polyline points="20 6 9 17 4 12" />,
}
function Icon({ name, size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICON_PATHS[name]}
    </svg>
  )
}

// ─── BADGE ────────────────────────────────────────────────────────────────────
function Badge({ children, color = '#6b7280', bg = '#f3f4f6' }) {
  return <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: bg, color, fontWeight: 500 }}>{children}</span>
}

export default function App() {
  const [marcas, setMarcas]                   = useState([])
  const [marcaAtiva, setMarcaAtiva]           = useState(null)
  // Sempre reflete a marca mais recente, mesmo dentro de uma closure async antiga —
  // usado por loadHealth pra descartar resposta de uma marca que o usuário já trocou
  // (evita números "vazarem" de uma marca pra outra ao trocar rápido, ver useEffect abaixo).
  const marcaAtivaIdRef = useRef(null)
  useEffect(() => { marcaAtivaIdRef.current = marcaAtiva?.id ?? null }, [marcaAtiva])
  const [running, setRunning]                 = useState(false)
  const [expanded, setExpanded]               = useState({})
  const [linkedHighlight, setLinkedHighlight] = useState(null)
  const [showConfig, setShowConfig]           = useState(false)
  const [showMarcaModal, setShowMarcaModal]   = useState(false)
  const [marcaModalMode, setMarcaModalMode]   = useState('create')
  const [marcaForm, setMarcaForm]             = useState({ id: '', sgtm: '', eventMap: [] })
  const [marcaMsg, setMarcaMsg]               = useState(null)
  const [savingMarca, setSavingMarca]         = useState(false)
  const [sessions, setSessions]               = useState([])
  const [pastas, setPastas]                   = useState([])
  const [pastaAtiva, setPastaAtiva]           = useState(null) // null = "Todas"
  const [movendoSessao, setMovendoSessao]     = useState(null) // id da sessão com dropdown de mover aberto
  const [recordedFlows, setRecordedFlows]     = useState([])
  const [runningFlow, setRunningFlow]         = useState(null)
  const [selectedSession, setSelectedSession] = useState(null)
  const [sessionDetail, setSessionDetail]     = useState(null)
  const [loadingSession, setLoadingSession]   = useState(false)
  const [deletingSession, setDeletingSession] = useState(null)
  const [activeNav, setActiveNav]             = useState('dashboard')
  const [plataforma, setPlataforma]             = useState(null)
  const [marcaSelecionada, setMarcaSelecionada] = useState(false)
  const [versaoInfo, setVersaoInfo]           = useState(null) // { versao, notas, downloadUrl }
  const [exportando, setExportando]           = useState(false)
  const [expandedSessionTab, setExpandedSessionTab] = useState('resumo')
  const [healthData, setHealthData]               = useState(null)
  const [healthOverview, setHealthOverview]       = useState(null)
  const [healthOverviewLoading, setHealthOverviewLoading] = useState(false)
  const [healthSubView, setHealthSubView]         = useState('overview')
  const [healthMarcasFiltro, setHealthMarcasFiltro] = useState('todos') // 'todos' | 'principais' — base de cálculo da tabela de marcas
  const [healthLoading, setHealthLoading]         = useState(false)
  const [healthSessionId, setHealthSessionId]     = useState(null)
  const [healthResult, setHealthResult]           = useState(null)
  const [healthResultLoading, setHealthResultLoading] = useState(false)
  const [flowLog, setFlowLog]                         = useState(null)
  const [flowLogLoading, setFlowLogLoading]           = useState(false)
  const [selectedGA4, setSelectedGA4]               = useState(new Set())
  const [eventoFiltro, setEventoFiltro]             = useState('')
  const [soComProblema, setSoComProblema]           = useState(false)
  const [testUrl, setTestUrl]                 = useState('')
  const [gtmPreviewUrl, setGtmPreviewUrl]     = useState('')
  const [deletingFlow, setDeletingFlow]       = useState(null)
  const [liveSession, setLiveSession]         = useState(null) // { events: [], startedAt } | null — captura ao vivo da extensão
  const [liveFeedOpen, setLiveFeedOpen]       = useState(false)
  const [liveInspectIndex, setLiveInspectIndex] = useState(0)
  const [extensaoBridgeOk, setExtensaoBridgeOk] = useState(null) // null=aguardando, true=respondeu, false=timeout sem resposta
  const [liveDismissed, setLiveDismissed] = useState(false) // escape hatch: usuário fechou o banner manualmente (ex.: estado preso na extensão)

  useEffect(() => {
    axios.get(`${API}/api/marcas`).then(({ data }) => {
      setMarcas(data)
    })
    // Busca versão da extensão
    axios.get(`${API}/api/extensao/versao`).then(({ data }) => {
      setVersaoInfo(data)
    }).catch(() => {})
  }, [])

  // ─── CAPTURA AO VIVO: ponte com a extensão via content script ────────────────
  // A extensão não sabe a marca da sessão até "Salvar" no final — por isso o
  // indicador é global (não preso a uma marca/pasta específica) e mostra só o
  // lado dataLayer, sem tentar confirmar GA4 (isso exigiria ver a sessão
  // inteira de uma vez, ver a lógica de pareamento em validator.js).
  useEffect(() => {
    function handleMessage(evt) {
      if (evt.source !== window || evt.data?.source !== 'faro-extension') return
      const msg = evt.data
      setExtensaoBridgeOk(true) // qualquer mensagem da extensão já prova que a ponte funciona
      if (msg.type === 'FARO_LIVE_SESSION_STATE') {
        setLiveSession(msg.active ? { events: [...(msg.events ?? [])].reverse(), startedAt: msg.startedAt ?? Date.now() } : null)
      } else if (msg.type === 'FARO_LIVE_SESSION_START') {
        setLiveDismissed(false) // uma captura nova de verdade sempre reaparece, mesmo se a anterior foi dispensada
        setLiveSession({ events: [], startedAt: msg.startedAt ?? Date.now() })
      } else if (msg.type === 'FARO_LIVE_EVENT') {
        setLiveSession(prev => prev ? { ...prev, events: [msg.event, ...prev.events] } : { events: [msg.event], startedAt: Date.now() })
      } else if (msg.type === 'FARO_LIVE_SESSION_STOP') {
        setLiveSession(null)
        setLiveFeedOpen(false)
      }
    }
    window.addEventListener('message', handleMessage)
    // Pergunta o estado atual e RE-registra essa aba periodicamente — o
    // service worker da extensão (MV3) é desligado pelo próprio Chrome após
    // um tempo sem atividade, e ao "acordar" de novo esquece completamente
    // quem tinha se registrado como dashboard. Sem repetir isso, uma captura
    // iniciada bem depois de abrir o dashboard nunca chegaria de volta aqui.
    const subscribe = () => window.postMessage({ source: 'faro-dashboard', type: 'FARO_LIVE_SUBSCRIBE' }, '*')
    subscribe()
    const heartbeat = setInterval(subscribe, 5000)
    // Se mesmo assim não vier resposta nenhuma da extensão, ou ela não está
    // instalada/recarregada nesta aba, ou o content script não injetou aqui —
    // sinaliza isso na tela em vez de falhar silenciosamente
    const timer = setTimeout(() => setExtensaoBridgeOk(prev => prev === null ? false : prev), 3000)
    return () => { window.removeEventListener('message', handleMessage); clearInterval(heartbeat); clearTimeout(timer) }
  }, [])

  function selecionaMarca(marca, lista) {
    const m = lista ? lista.find(x => x.id === marca.id) : marca
    setMarcaAtiva(m)
    setSelectedSession(null)
    setSessionDetail(null)
    setMarcaSelecionada(true)
    setPastaAtiva(null)
    axios.get(`${API}/api/sessions/${m.id}`).then(({ data }) => setSessions(data)).catch(() => setSessions([]))
    axios.get(`${API}/api/flows/${m.id}`).then(({ data }) => setRecordedFlows(data)).catch(() => setRecordedFlows([]))
    axios.get(`${API}/api/folders/${m.id}`).then(({ data }) => setPastas(data)).catch(() => setPastas([]))
  }

  async function atualizarDados() {
    if (!marcaAtiva) return
    try {
      const [{ data: s }, { data: f }, { data: p }] = await Promise.all([
        axios.get(`${API}/api/sessions/${marcaAtiva.id}`),
        axios.get(`${API}/api/flows/${marcaAtiva.id}`),
        axios.get(`${API}/api/folders/${marcaAtiva.id}`).catch(() => ({ data: [] })),
      ])
      setSessions(s)
      setRecordedFlows(f)
      setPastas(p)
      if (selectedSession) {
        const { data } = await axios.get(`${API}/api/sessions/${marcaAtiva.id}/${selectedSession}`)
        setSessionDetail(data)
      }
    } catch {}
  }

  function toggleExpanded(key) {
    setExpanded(prev => ({ ...prev, [key]: !prev[key] }))
  }

  // Cabeçalho de card expansível que já tem um botão próprio dentro (ex.: "⇄ GA4") não
  // pode virar <button> — botão dentro de botão é HTML inválido e quebra o DOM. Fica
  // como div com role="button"/tabIndex, com este handler cobrindo Enter/Espaço pra
  // manter a operação por teclado mesmo assim.
  function onKeyToggle(e, key) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpanded(key) }
  }

  // Rola até o card correspondente do outro lado (dataLayer <-> GA4) e acende um
  // destaque temporário — os dois lados usam o mesmo índice i (vêm da mesma lista,
  // validacao.eventos), então achar o par é só montar o id do lado oposto.
  function irParaPar(i, lado) {
    setLinkedHighlight(i)
    document.getElementById(`par-${lado}-${i}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    clearTimeout(window.__linkHlTimer)
    window.__linkHlTimer = setTimeout(() => setLinkedHighlight(prev => prev === i ? null : prev), 2200)
  }

  function openCreateMarca() {
    setMarcaModalMode('create')
    setMarcaForm({ id: '', sgtm: '', eventMap: [] })
    setMarcaMsg(null)
    setShowMarcaModal(true)
  }

  function openEditMarca(e, marca) {
    e.stopPropagation()
    fetch(`${API}/api/marcas/${marca.id}/config`).then(r => r.json()).then(cfg => {
      const eventMapArr = Object.entries(cfg.eventMap ?? {}).map(([k, v]) => ({ k, v }))
      setMarcaForm({ id: marca.id, sgtm: cfg.sgtm ?? '', eventMap: eventMapArr })
      setMarcaModalMode('edit')
      setMarcaMsg(null)
      setShowMarcaModal(true)
    })
  }

  async function saveMarca() {
    const { id, sgtm, eventMap } = marcaForm
    if (!sgtm) return setMarcaMsg({ ok: false, msg: 'Domínio sGTM é obrigatório' })
    if (marcaModalMode === 'create' && !id) return setMarcaMsg({ ok: false, msg: 'Nome da marca é obrigatório' })
    const eventMapObj = {}
    eventMap.forEach(({ k, v }) => { if (k.trim()) eventMapObj[k.trim()] = v.trim() })
    setSavingMarca(true)
    try {
      if (marcaModalMode === 'create') {
        const r = await fetch(`${API}/api/marcas`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, sgtm, eventMap: eventMapObj }) })
        const data = await r.json()
        if (!r.ok) { setMarcaMsg({ ok: false, msg: data.error }); setSavingMarca(false); return }
      } else {
        const r = await fetch(`${API}/api/marcas/${marcaForm.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sgtm, eventMap: eventMapObj }) })
        const data = await r.json()
        if (!r.ok) { setMarcaMsg({ ok: false, msg: data.error }); setSavingMarca(false); return }
      }
      const { data: marcasData } = await axios.get(`${API}/api/marcas`)
      setMarcas(marcasData)
      if (marcaModalMode === 'create') {
        const slugCriado = id.toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-').trim()
        const nova = marcasData.find(m => m.id === slugCriado) ?? { id: slugCriado, name: slugCriado, fluxos: [] }
        selecionaMarca(nova, marcasData.length > 0 ? marcasData : [nova])
      }
      setShowMarcaModal(false)
    } catch { setMarcaMsg({ ok: false, msg: 'Erro ao salvar marca' }) }
    setSavingMarca(false)
  }

  function addEventMapRow() { setMarcaForm(f => ({ ...f, eventMap: [...f.eventMap, { k: '', v: '' }] })) }
  function removeEventMapRow(i) { setMarcaForm(f => ({ ...f, eventMap: f.eventMap.filter((_, idx) => idx !== i) })) }
  function updateEventMapRow(i, field, val) { setMarcaForm(f => ({ ...f, eventMap: f.eventMap.map((r, idx) => idx === i ? { ...r, [field]: val } : r) })) }

  async function runAll() {
    if (!marcaAtiva || running) return
    setRunning(true)
    try { await axios.post(`${API}/api/run-all/${marcaAtiva.id}`) } catch {}
    setRunning(false)
  }

  async function runRecordedFlow(flow) {
    if (runningFlow) return
    setRunningFlow(flow.id)
    try {
      const { data } = await axios.post(`${API}/api/run-flow/${marcaAtiva.id}/${flow.id}`)
      if (data.success) {
        const { data: sessoes } = await axios.get(`${API}/api/sessions/${marcaAtiva.id}`)
        setSessions(sessoes)
        setActiveNav('sessoes')
      } else { alert('Erro: ' + (data.error ?? 'erro desconhecido')) }
    } catch (e) { alert('Erro ao rodar fluxo: ' + (e.response?.data?.error ?? e.message)) }
    setRunningFlow(null)
  }

  async function validateSnapshot(flow) {
    if (runningFlow) return
    setRunningFlow(flow.id + '-snapshot')
    try {
      const { data } = await axios.post(`${API}/api/validate-snapshot/${marcaAtiva.id}/${flow.id}`)
      if (data.success) {
        const { data: sessoes } = await axios.get(`${API}/api/sessions/${marcaAtiva.id}`)
        setSessions(sessoes)
        setActiveNav('sessoes')
      } else { alert('Erro: ' + (data.error ?? 'erro desconhecido')) }
    } catch (e) { alert('Erro ao validar snapshot: ' + (e.response?.data?.error ?? e.message)) }
    setRunningFlow(null)
  }

  async function importAndRunRecorder(flow) {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = async (e) => {
      const file = e.target.files[0]
      if (!file) return
      try {
        const text = await file.text()
        const recording = JSON.parse(text)
        if (!recording?.steps) { alert('JSON invalido — exporte do Chrome DevTools Recorder'); return }
        setRunningFlow(flow.id + '-recorder')
        const { data } = await axios.post(`${API}/api/run-recorder/${marcaAtiva.id}`, {
          recording, nome: flow.nome, sgtmDomain: flow.sgtmDomain ?? ''
        })
        if (data.success) {
          const { data: sessoes } = await axios.get(`${API}/api/sessions/${marcaAtiva.id}`)
          setSessions(sessoes)
          setActiveNav('sessoes')
        } else { alert('Erro: ' + (data.error ?? 'erro desconhecido')) }
        setRunningFlow(null)
      } catch (e) { alert('Erro: ' + e.message); setRunningFlow(null) }
    }
    input.click()
  }

  async function loadHealth() {
    // Carrega overview ao mesmo tempo
    if (!healthOverview && !healthOverviewLoading) {
      setHealthOverviewLoading(true)
      axios.get(`${API}/api/health/overview`).then(({ data }) => setHealthOverview(data)).catch(() => {}).finally(() => setHealthOverviewLoading(false))
    }
    // Lê a marca do REF, não da variável "marcaAtiva" fechada nesta closure — loadHealth
    // é agendado via setTimeout(loadHealth, 100) a partir do clique (ver seleção de
    // marca), e nesse instante o closure ainda enxerga a marca de ANTES do clique
    // (setMarcaAtiva ainda não comitou quando essa linha roda). O ref, atualizado por um
    // useEffect que reage ao estado de verdade, sempre reflete a marca certa no momento
    // em que loadHealth de fato executa 100ms depois.
    //
    // Além disso: antes, o guard "healthLoading" bloqueava um novo loadHealth() enquanto
    // o anterior ainda estava em voo — trocar de marca rápido fazia o clique novo ser
    // ignorado (o header já mudava de marca, mas o resultado antigo continuava na tela)
    // e, quando a resposta atrasada finalmente chegava, ela "vazava" pro card da marca
    // errada. Agora cada clique dispara sua própria busca, e cada resposta só é aplicada
    // se marcaAtivaIdRef ainda apontar pra essa mesma marca — senão é descartada.
    const marcaAlvo = marcaAtivaIdRef.current
    if (!marcaAlvo) return
    setHealthLoading(true)
    setHealthResult(null)
    try {
      // Carrega sessão de saúde definida para esta marca
      const { data: cfg } = await axios.get(`${API}/api/health-set/${marcaAlvo}`)
      if (marcaAtivaIdRef.current !== marcaAlvo) return // usuário já trocou de marca
      if (cfg?.sessionId) {
        setHealthSessionId(cfg.sessionId)
        const { data } = await axios.get(`${API}/api/health-session/${marcaAlvo}/${cfg.sessionId}`)
        if (marcaAtivaIdRef.current !== marcaAlvo) return // usuário já trocou de marca
        setHealthResult(data)
      }
    } catch (e) { console.error('Health error', e) }
    if (marcaAtivaIdRef.current === marcaAlvo) setHealthLoading(false)
  }

  async function loadFlowLog(marca, flowId) {
    setFlowLogLoading(true)
    setFlowLog(null)
    try {
      const { data } = await axios.get(`${API}/api/flows/log/${marca}/${flowId}`)
      setFlowLog(data)
    } catch {}
    setFlowLogLoading(false)
  }

  async function setHealthSession(sessionId) {
    if (!marcaAtiva) return
    try {
      await axios.post(`${API}/api/health-set/${marcaAtiva.id}`, { sessionId })
      setHealthSessionId(sessionId)
      setActiveNav('saude')
      setHealthResultLoading(true)
      setHealthResult(null)
      const { data } = await axios.get(`${API}/api/health-session/${marcaAtiva.id}/${sessionId}`)
      setHealthResult(data)
      setHealthResultLoading(false)
    } catch (e) { console.error('Set health error', e); setHealthResultLoading(false) }
  }

  async function unsetHealthSession() {
    if (!marcaAtiva) return
    try {
      await axios.post(`${API}/api/health-set/${marcaAtiva.id}`, { sessionId: null })
      setHealthSessionId(null)
      setHealthResult(null)
    } catch (e) { console.error('Unset health error', e) }
  }

  async function deleteRecordedFlow(e, flow) {
    e.stopPropagation()
    if (!window.confirm(`Excluir fluxo "${flow.nome}"?`)) return
    try {
      await axios.delete(`${API}/api/flows/${marcaAtiva.id}/${flow.id}`)
      setRecordedFlows(prev => prev.filter(f => f.id !== flow.id))
    } catch { alert('Erro ao excluir fluxo') }
  }

  async function loadSession(id) {
    setLoadingSession(true)
    setSelectedSession(id)
    setSessionDetail(null)
    setSelectedGA4(new Set())
    setExpandedSessionTab('resumo')
    try {
      const { data } = await axios.get(`${API}/api/sessions/${marcaAtiva.id}/${id}`)
      setSessionDetail(data)
    } catch { setSessionDetail(null) }
    setLoadingSession(false)
  }

  async function deleteSession(e, session) {
    e.stopPropagation()
    if (!window.confirm(`Excluir sessão "${session.nome}"?`)) return
    setDeletingSession(session.id)
    try {
      await axios.delete(`${API}/api/sessions/${marcaAtiva.id}/${session.id}`)
      setSessions(prev => prev.filter(s => s.id !== session.id))
      if (selectedSession === session.id) { setSelectedSession(null); setSessionDetail(null) }
    } catch { alert('Erro ao excluir sessão') }
    setDeletingSession(null)
  }

  async function moverSessaoParaPasta(e, session, pasta) {
    if (e) e.stopPropagation()
    try {
      await axios.patch(`${API}/api/sessions/${marcaAtiva.id}/${session.id}/pasta`, { pasta })
      setSessions(prev => prev.map(s => s.id === session.id ? { ...s, pasta } : s))
      if (pasta && !pastas.includes(pasta)) setPastas(prev => [...prev, pasta].sort())
    } catch { alert('Erro ao mover sessão') }
    setMovendoSessao(null)
  }

  function criarPastaEMover(e, session) {
    if (e) e.stopPropagation()
    const nome = window.prompt('Nome da nova pasta:')
    if (!nome || !nome.trim()) return
    moverSessaoParaPasta(null, session, nome.trim())
  }

  async function exportPDF(session) {
    setExportando(session.id)
    try {
      const resp = await fetch(`${API}/api/sessions/${marcaAtiva.id}/${session.id}/pdf`)
      if (!resp.ok) throw new Error('Erro ao gerar PDF')
      const blob = await resp.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href = url; a.download = `relatorio-${session.nome?.replace(/\s+/g,'-')}-${marcaAtiva.id}.pdf`
      a.click(); URL.revokeObjectURL(url)
    } catch (e) { alert('Erro ao exportar PDF: ' + e.message) }
    setExportando(null)
  }

  async function exportPDFSelecionados() {
    if (!sessionDetail || selectedGA4.size === 0) return
    // Índices se referem à mesma lista da esquerda (validacao.eventos), não mais a
    // ga4Events cru — cada linha selecionada já carrega seu próprio veredito de GA4
    // em ev.ga4 (ver coluna "GA4 capturado"), então a seleção é sobre disparos, não
    // sobre hits de GA4 isolados.
    const indices     = Array.from(selectedGA4)
    const dlFiltrado  = indices.map(i => sessionDetail.validacao?.eventos?.[i]).filter(Boolean)
    const ga4Filtrado = dlFiltrado.map(ev => ev.ga4?.raw).filter(Boolean)
    const nomes       = [...new Set(dlFiltrado.map(ev => ev.event ?? ''))].join(', ')
    const eventNames  = new Set(dlFiltrado.map(ev => ev.event ?? ''))
    const cmpFiltrado = (sessionDetail.comparacao ?? []).filter(c => eventNames.has(c.ga4Event) || eventNames.has(c.dlEvent))
    const incFiltrado = (sessionDetail.inconsistencias ?? []).filter(inc => eventNames.has(inc.evento_origem) && eventNames.has(inc.evento_atual))
    const passedFiltrado = dlFiltrado.filter(ev => ev.status === 'passou').length
    const failedFiltrado = dlFiltrado.filter(ev => ev.status === 'falhou').length
    const sessaoFiltrada = { ...sessionDetail, ga4Events: ga4Filtrado, comparacao: cmpFiltrado, inconsistencias: incFiltrado, validacao: { ...sessionDetail.validacao, eventos: dlFiltrado, summary: { total: dlFiltrado.length, passed: passedFiltrado, failed: failedFiltrado, unknown: dlFiltrado.filter(ev => ev.status === 'desconhecido').length, erros: failedFiltrado } }, _filtro: nomes }
    setExportando(selectedSession + '_sel')
    try {
      const resp = await fetch(`${API}/api/sessions/pdf-custom`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sessaoFiltrada) })
      if (!resp.ok) throw new Error('Erro ao gerar PDF')
      const blob = await resp.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href = url; a.download = `relatorio-${sessionDetail.nome?.replace(/\s+/g,'-')}-${nomes.replace(/[^a-z0-9]/gi,'-').slice(0,30)}.pdf`
      a.click(); URL.revokeObjectURL(url)
    } catch (e) { alert('Erro ao exportar: ' + e.message) }
    setExportando(null)
  }

  // ─── TELA DE SELEÇÃO DE PLATAFORMA ───────────────────────────────────────
  if (!plataforma) {
    return (
      <div style={{ minHeight: '100vh', background: 'linear-gradient(135deg, #0f1e35 0%, #1a3a5c 100%)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontFamily: "'DM Sans', system-ui, sans-serif", padding: '32px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, marginBottom: 12 }}>
          <svg width="44" height="60" viewBox="155 105 190 260" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Faro">
            <path d="M250 120 L330 350 L250 280 L170 350 Z" fill="none" stroke="#D0D0D0" strokeWidth="20" strokeLinejoin="round" />
            <line x1="250" y1="120" x2="250" y2="280" stroke="#D0D0D0" strokeWidth="20" strokeLinecap="round" />
          </svg>
          <span style={{ fontSize: 19, fontWeight: 700, color: '#fff', letterSpacing: '.14em', lineHeight: 1 }}>FARO</span>
        </div>
        <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: 14, marginBottom: 48, marginTop: 0 }}>Validação de tracking · grupo</p>
        <div style={{ background: 'rgba(255,255,255,0.05)', borderRadius: 20, padding: '36px 40px', width: '100%', maxWidth: 520, backdropFilter: 'blur(10px)', border: '1px solid rgba(255,255,255,0.1)' }}>
          <h2 style={{ margin: '0 0 8px', fontSize: 20, fontWeight: 700, color: '#fff', textAlign: 'center' }}>Onde você vai validar hoje?</h2>
          <p style={{ margin: '0 0 32px', fontSize: 13, color: 'rgba(255,255,255,0.7)', textAlign: 'center' }}>Escolha a plataforma para iniciar a validação</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <button
              onClick={() => setPlataforma('web')}
              style={{ padding: '28px 16px', borderRadius: 14, border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.08)', cursor: 'pointer', color: '#fff', fontSize: 15, fontWeight: 600, transition: 'all .2s', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}
              onMouseEnter={e => { e.currentTarget.style.background='rgba(37,99,235,0.4)'; e.currentTarget.style.borderColor='#60a5fa'; }}
              onMouseLeave={e => { e.currentTarget.style.background='rgba(255,255,255,0.08)'; e.currentTarget.style.borderColor='rgba(255,255,255,0.15)'; }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#D0D0D0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <path d="M2 12h20" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
              <span>Web</span>
              <span style={{ fontSize: 11, fontWeight: 400, color: 'rgba(255,255,255,0.65)', marginTop: -4 }}>GTM · DataLayer · GA4</span>
            </button>
            <button
              onClick={() => window.location.href = '/mobile'}
              style={{ padding: '28px 16px', borderRadius: 14, border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.08)', cursor: 'pointer', color: '#fff', fontSize: 15, fontWeight: 600, transition: 'all .2s', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}
              onMouseEnter={e => { e.currentTarget.style.background='rgba(16,185,129,0.35)'; e.currentTarget.style.borderColor='#34d399'; }}
              onMouseLeave={e => { e.currentTarget.style.background='rgba(255,255,255,0.08)'; e.currentTarget.style.borderColor='rgba(255,255,255,0.15)'; }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#D0D0D0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
                <line x1="12" y1="18" x2="12.01" y2="18" />
              </svg>
              <span>App</span>
              <span style={{ fontSize: 11, fontWeight: 400, color: 'rgba(255,255,255,0.65)', marginTop: -4 }}>Firebase · ADB · Flutter</span>
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ─── TELA DE SELEÇÃO DE MARCA ─────────────────────────────────────────────
  if (!marcaSelecionada) {
    return (
      <div style={{ minHeight: '100vh', background: 'linear-gradient(135deg, #0f1e35 0%, #1a3a5c 100%)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontFamily: "'DM Sans', system-ui, sans-serif", padding: '32px', position: 'relative' }}>
        <button onClick={() => setPlataforma(null)} title="Voltar para Home" style={{ position: 'absolute', top: 24, left: 28, background: 'none', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 8, color: 'rgba(255,255,255,0.6)', cursor: 'pointer', fontSize: 13, padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" /></svg>
          Home
        </button>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, marginBottom: 12 }}>
          <svg width="44" height="60" viewBox="155 105 190 260" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Faro">
            <path d="M250 120 L330 350 L250 280 L170 350 Z" fill="none" stroke="#D0D0D0" strokeWidth="20" strokeLinejoin="round" />
            <line x1="250" y1="120" x2="250" y2="280" stroke="#D0D0D0" strokeWidth="20" strokeLinecap="round" />
          </svg>
          <span style={{ fontSize: 19, fontWeight: 700, color: '#fff', letterSpacing: '.14em', lineHeight: 1 }}>FARO</span>
        </div>
        <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: 14, marginBottom: 48, marginTop: 0 }}>Validação de tracking · grupo</p>
        <div style={{ background: 'rgba(255,255,255,0.05)', borderRadius: 20, padding: '36px 40px', width: '100%', maxWidth: 520, backdropFilter: 'blur(10px)', border: '1px solid rgba(255,255,255,0.1)' }}>
          <h2 style={{ margin: '0 0 8px', fontSize: 20, fontWeight: 700, color: '#fff', textAlign: 'center' }}>Selecione a marca</h2>
          <p style={{ margin: '0 0 28px', fontSize: 13, color: 'rgba(255,255,255,0.7)', textAlign: 'center' }}>Escolha com qual marca você vai trabalhar hoje</p>
          {marcas.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.65)', fontSize: 13 }}>Carregando marcas...</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: marcas.length > 3 ? 'repeat(2,1fr)' : `repeat(${Math.min(marcas.length,3)},1fr)`, gap: 12 }}>
              {marcas.map(m => (
                <button key={m.id} onClick={() => selecionaMarca(m, marcas)} style={{ padding: '18px 16px', borderRadius: 12, border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.08)', cursor: 'pointer', color: '#fff', fontSize: 15, fontWeight: 600, transition: 'all .2s', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}
                  onMouseEnter={e => { e.currentTarget.style.background='rgba(37,99,235,0.4)'; e.currentTarget.style.borderColor='#60a5fa'; }}
                  onMouseLeave={e => { e.currentTarget.style.background='rgba(255,255,255,0.08)'; e.currentTarget.style.borderColor='rgba(255,255,255,0.15)'; }}>
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#D0D0D0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82Z" />
                    <line x1="7" y1="7" x2="7.01" y2="7" />
                  </svg>
                  {m.name}
                </button>
              ))}
            </div>
          )}
          <div style={{ marginTop: 20, textAlign: 'center' }}>
            <button onClick={openCreateMarca} style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)', background: 'none', border: 'none', cursor: 'pointer' }}>+ Adicionar nova marca</button>
          </div>
        </div>

        {/* Modal marca (para criar nova da tela inicial) */}
        {showMarcaModal && (
          <div role="dialog" aria-modal="true" aria-labelledby="nova-marca-heading" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
            <div style={{ background: '#132a49', borderRadius: 16, padding: '28px', width: 480, maxWidth: '90vw', border: '1px solid rgba(255,255,255,0.12)' }}>
              <h2 id="nova-marca-heading" style={{ margin: '0 0 20px', fontSize: 17, fontWeight: 700, color: '#fff' }}>Nova marca</h2>
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 13, fontWeight: 500, display: 'block', marginBottom: 6, color: 'rgba(255,255,255,0.8)' }}>ID da marca</label>
                <input type="text" placeholder="ex: marca-f" value={marcaForm.id} onChange={e => setMarcaForm(f => ({ ...f, id: e.target.value }))} style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.2)', background: 'rgba(255,255,255,0.08)', color: '#fff', fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 13, fontWeight: 500, display: 'block', marginBottom: 6, color: 'rgba(255,255,255,0.8)' }}>Domínio sGTM</label>
                <input type="text" placeholder="ex: sgtm.marca-f.exemplo.com.br" value={marcaForm.sgtm} onChange={e => setMarcaForm(f => ({ ...f, sgtm: e.target.value }))} style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.2)', background: 'rgba(255,255,255,0.08)', color: '#fff', fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
              </div>
              {marcaMsg && <div style={{ padding: '10px 12px', borderRadius: 8, background: marcaMsg.ok ? 'rgba(22,163,74,0.15)' : 'rgba(220,38,38,0.15)', color: marcaMsg.ok ? '#4ade80' : '#f87171', fontSize: 13, marginBottom: 14 }}>{marcaMsg.msg}</div>}
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button onClick={() => setShowMarcaModal(false)} style={{ padding: '10px 18px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.2)', background: 'none', color: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancelar</button>
                <button onClick={saveMarca} disabled={savingMarca} style={{ padding: '10px 18px', borderRadius: 8, border: 'none', background: ACCENT, color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                  {savingMarca ? 'Salvando...' : 'Criar marca'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }
  const colHeader = { fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }
  const eventRow  = { background: '#fff', border: '1px solid #f1f5f9', borderRadius: 8, marginBottom: 6, overflow: 'hidden' }
  const eventHeader = (cursor) => ({ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', cursor: cursor ? 'pointer' : 'default' })
  const badge = (bg, color) => ({ fontSize: 11, padding: '2px 7px', borderRadius: 6, background: bg, color })

  return (
    <div style={{ display: 'flex', minHeight: '100vh', fontFamily: "'DM Sans', system-ui, sans-serif", background: '#f8fafc' }}>

      {/* ─── SIDEBAR ─── */}
      <aside style={{ width: SIDEBAR_W, minWidth: SIDEBAR_W, background: SIDEBAR_BG, display: 'flex', flexDirection: 'column', padding: '20px 12px', position: 'fixed', top: 0, left: 0, height: '100vh', zIndex: 10 }}>
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 20, padding: '8px 4px', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: 20 }}>
          <svg width="22" height="30" viewBox="155 105 190 260" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Faro">
            <path d="M250 120 L330 350 L250 280 L170 350 Z" fill="none" stroke="#D0D0D0" strokeWidth="20" strokeLinejoin="round" />
            <line x1="250" y1="120" x2="250" y2="280" stroke="#D0D0D0" strokeWidth="20" strokeLinecap="round" />
          </svg>
          <span style={{ fontSize: 15, fontWeight: 700, color: '#fff', letterSpacing: '.12em', lineHeight: 1 }}>FARO</span>
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <NavItem icon={<Icon name="home" />}     label="Dashboard"          active={activeNav === 'dashboard'}   onClick={() => setActiveNav('dashboard')} />
          <NavItem icon={<Icon name="flows" />}    label="Fluxos Gravados"    active={activeNav === 'fluxos'}      onClick={() => setActiveNav('fluxos')} />
          <NavItem icon={<Icon name="puzzle" />}   label="Sessões de Extensão" active={activeNav === 'sessoes'}    onClick={() => setActiveNav('sessoes')} />
          <NavItem icon={<Icon name="heart" />}    label="Saúde"               active={activeNav === 'saude'}       onClick={() => { setActiveNav('saude'); loadHealth(); }} />
          <NavItem icon={<Icon name="book" />}     label="Instruções"         active={activeNav === 'instrucoes'}  onClick={() => setActiveNav('instrucoes')} />
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', margin: '8px 0' }} />
          <NavItem icon={<Icon name="settings" />} label="Configurações"      active={activeNav === 'config'}      onClick={() => setActiveNav('config')} />
          <NavItem icon={<Icon name="tag" />}      label="Marcas"             active={activeNav === 'marcas'}      onClick={() => setActiveNav('marcas')} />
        </nav>

        {/* Bottom */}
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 12 }}>
          <button onClick={() => setMarcaSelecionada(false)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 8, background: 'rgba(255,255,255,0.06)', border: 'none', cursor: 'pointer', marginBottom: 8 }}
            onMouseEnter={e => e.currentTarget.style.background='rgba(255,255,255,0.12)'}
            onMouseLeave={e => e.currentTarget.style.background='rgba(255,255,255,0.06)'}>
            <div style={{ width: 32, height: 32, borderRadius: '50%', background: ACCENT, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', flexShrink: 0 }}><Icon name="tag" size={15} /></div>
            <div style={{ textAlign: 'left', overflow: 'hidden' }}>
              <div style={{ fontSize: 12, color: '#fff', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{marcaAtiva?.name ?? 'Marca'}</div>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.68)' }}>Trocar marca</div>
            </div>
          </button>
        </div>
      </aside>

      {/* ─── MAIN ─── */}
      <main style={{ marginLeft: SIDEBAR_W, flex: 1, display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>

        {/* Top bar */}
        <header style={{ background: '#fff', borderBottom: '1px solid #e2e8f0', padding: '16px 32px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'sticky', top: 0, zIndex: 5 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#0f172a' }}>
              { activeNav === 'dashboard'  ? 'Dashboard' :
                activeNav === 'fluxos'    ? 'Fluxos Gravados' :
                activeNav === 'sessoes'   ? 'Sessões de Extensão' :
                activeNav === 'saude'      ? 'Saúde do Tracking' :
                activeNav === 'instrucoes'? 'Instruções' :
                activeNav === 'config'    ? 'Configurações' :
                                            'Marcas' }
            </h1>
            <p style={{ margin: '2px 0 0', fontSize: 13, color: '#64748b' }}>
              { marcaAtiva ? `Marca ativa: ${marcaAtiva.name}` : 'Selecione uma marca' }
            </p>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button onClick={() => { if (window.confirm('Voltar pra tela inicial? Isso sai da marca e da plataforma atual.')) setPlataforma(null) }} title="Voltar para Home" aria-label="Voltar para Home" style={{ background: 'none', border: '1px solid #e2e8f0', borderRadius: 8, padding: '7px 10px', cursor: 'pointer', lineHeight: 1, color: '#64748b', display: 'flex' }}>
              <Icon name="home" />
            </button>
            {/* Seletor de marcas */}
            <div style={{ display: 'flex', gap: 6 }}>
              {marcas.map(m => (
                <button key={m.id} onClick={() => selecionaMarca(m, null)} style={{ padding: '6px 14px', borderRadius: 20, fontSize: 12, cursor: 'pointer', border: marcaAtiva?.id === m.id ? `2px solid ${ACCENT}` : '1px solid #e2e8f0', background: marcaAtiva?.id === m.id ? ACCENT_LIGHT : '#fff', color: marcaAtiva?.id === m.id ? ACCENT : '#64748b', fontWeight: marcaAtiva?.id === m.id ? 600 : 400 }}>
                  {m.name}
                </button>
              ))}
            </div>
            <button onClick={atualizarDados} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff', color: '#374151', cursor: 'pointer', fontSize: 13, fontWeight: 500 }}>
              <Icon name="refresh" size={14} /> Atualizar
            </button>
            <button onClick={runAll} disabled={running} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 18px', borderRadius: 8, border: 'none', background: running ? '#64748b' : ACCENT, color: '#fff', cursor: running ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600 }}>
              <Icon name="play" size={12} /> {running ? 'Rodando...' : 'Rodar todos'}
            </button>
          </div>
        </header>

        {/* Content */}
        <div style={{ padding: '28px 32px', flex: 1 }}>

          {/* Banner de captura ao vivo — global (não preso a uma marca), porque a
              extensão só sabe a marca da sessão quando ela é salva no final */}
          {liveSession && !liveDismissed && (
            <div role="button" tabIndex={0} onClick={() => { setLiveFeedOpen(true); setLiveInspectIndex(0) }} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setLiveFeedOpen(true); setLiveInspectIndex(0) } }}
              style={{ background: 'linear-gradient(90deg, #b91c1c, #dc2626)', borderRadius: 10, padding: '12px 20px', marginBottom: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, cursor: 'pointer' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span className="faro-live-dot" style={{ width: 10, height: 10, borderRadius: '50%', background: '#fff', flexShrink: 0 }} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>Captura ao vivo em andamento</div>
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.8)', marginTop: 2 }}>
                    {liveSession.events.length} disparo{liveSession.events.length !== 1 ? 's' : ''} do dataLayer — clique pra acompanhar em tempo real
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: '#b91c1c', background: '#fff', padding: '7px 16px', borderRadius: 8 }}>Ver ao vivo →</span>
                <button onClick={e => { e.stopPropagation(); setLiveDismissed(true) }} title="Dispensar (se não tiver captura de verdade rodando, recarregue a extensão)" aria-label="Dispensar aviso de captura ao vivo" style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.75)', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 4 }}>×</button>
              </div>
            </div>
          )}
          <style>{`
            @keyframes faro-live-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: .35; transform: scale(.65); } }
            .faro-live-dot { animation: faro-live-pulse 1.2s ease-in-out infinite; }
            @media (prefers-reduced-motion: reduce) { .faro-live-dot { animation: none; } }
          `}</style>

          {/* Diagnóstico temporário: a extensão nunca respondeu nesta aba —
              content script não injetou aqui (aba antiga de antes do reload,
              extensão não instalada, ou desatualizada) */}
          {activeNav === 'sessoes' && extensaoBridgeOk === false && (
            <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '12px 20px', marginBottom: 20, fontSize: 13, color: '#92400e' }}>
              ⚠ Não detectei a extensão Faro respondendo nesta aba. Feche esta aba, confirme que recarregou a extensão em <code>chrome://extensions</code>, e abra o dashboard numa aba nova.
            </div>
          )}

          {/* Banner de atualização da extensão */}
          {versaoInfo && (
            <div style={{ background: 'linear-gradient(90deg, #1d4ed8, #2563eb)', borderRadius: 10, padding: '12px 20px', marginBottom: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ display: 'flex', color: '#fff' }}><Icon name="bell" size={20} /></span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>Nova versão da extensão disponível — v{versaoInfo.versao}</div>
                  {versaoInfo.notas?.length > 0 && (
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.75)', marginTop: 2 }}>
                      {versaoInfo.notas[0]}{versaoInfo.notas.length > 1 ? ` +${versaoInfo.notas.length - 1} melhorias` : ''}
                    </div>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                <a href={versaoInfo.downloadUrl} download="faro-extensao.zip" style={{ padding: '8px 16px', borderRadius: 8, background: '#fff', color: '#1d4ed8', fontWeight: 700, fontSize: 12, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Icon name="download" size={13} /> Baixar v{versaoInfo.versao}
                </a>
                <button onClick={() => setVersaoInfo(null)} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.6)', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>×</button>
              </div>
            </div>
          )}

          {/* ══ DASHBOARD ══ */}
          {activeNav === 'dashboard' && (
            <div>
              {/* Stats cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 16, marginBottom: 28 }}>
                {[
                  { label: 'Fluxos Gravados',    value: recordedFlows.length, icon: 'flows', color: '#2563eb', bg: '#eff6ff', nav: 'fluxos' },
                  { label: 'Sessões Capturadas',  value: sessions.length,      icon: 'activity', color: '#7c3aed', bg: '#f5f3ff', nav: 'sessoes' },
                  { label: 'Erros encontrados',   value: sessions.reduce((a, s) => a + (s.validacao?.erros ?? 0), 0), icon: 'alert', color: '#dc2626', bg: '#fef2f2', nav: 'sessoes' },
                  { label: 'Marca ativa',         value: marcaAtiva?.name ?? '—', icon: 'tag', color: '#059669', bg: '#ecfdf5', isText: true, nav: 'marcas' },
                ].map(c => (
                  <div key={c.label} onClick={() => c.nav && setActiveNav(c.nav)} style={{ background: '#fff', borderRadius: 12, padding: '20px 24px', border: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', gap: 16, cursor: c.nav ? 'pointer' : 'default', transition: 'box-shadow .15s' }}
                    onMouseEnter={e => { if(c.nav) e.currentTarget.style.boxShadow='0 4px 16px rgba(0,0,0,0.08)' }}
                    onMouseLeave={e => { e.currentTarget.style.boxShadow='none' }}>
                    <div style={{ width: 44, height: 44, borderRadius: 10, background: c.bg, color: c.color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Icon name={c.icon} size={20} /></div>
                    <div>
                      <div style={{ fontSize: c.isText ? 16 : 26, fontWeight: 700, color: c.color }}>{c.value}</div>
                      <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{c.label}</div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Últimas sessões */}
              <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e2e8f0', overflow: 'hidden' }}>
                <div style={{ padding: '16px 24px', borderBottom: '1px solid #f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: '#0f172a' }}>Sessões recentes</h3>
                  <button onClick={() => setActiveNav('sessoes')} style={{ fontSize: 12, color: ACCENT, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 500 }}>Ver todas →</button>
                </div>
                {sessions.length === 0 ? (
                  <div style={{ padding: '32px', textAlign: 'center', color: '#64748b', fontSize: 13 }}>Nenhuma sessão capturada ainda</div>
                ) : sessions.slice(0,5).map(s => (
                  <div key={s.id} onClick={() => { setActiveNav('sessoes'); loadSession(s.id) }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 24px', borderBottom: '1px solid #f8fafc', cursor: 'pointer', transition: 'background .1s' }}
                    onMouseEnter={e => e.currentTarget.style.background='#f8fafc'}
                    onMouseLeave={e => e.currentTarget.style.background='transparent'}>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 500, color: '#0f172a' }}>{s.nome}</div>
                      <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{s.timestamp ? new Date(s.timestamp).toLocaleString('pt-BR') : ''}</div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      {s.ambiente === 'app'
                        ? <Badge bg='#f5f3ff' color='#7c3aed'><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="phone" size={11} /> app</span></Badge>
                        : <Badge bg='#eff6ff' color='#2563eb'><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="globe" size={11} /> web</span></Badge>}
                      <Badge bg='#eff6ff' color='#2563eb'>{s.dlCount} DL</Badge>
                      <Badge bg='#f0fdf4' color='#15803d'>{s.ga4Count} GA4</Badge>
                      {(s.validacao?.erros ?? 0) > 0
                        ? <Badge bg='#fef2f2' color='#dc2626'>{s.validacao.erros} erros</Badge>
                        : <Badge bg='#f0fdf4' color='#15803d'><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="check" size={11} /> ok</span></Badge>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ══ FLUXOS GRAVADOS ══ */}
          {activeNav === 'fluxos' && (
            <div>
              {recordedFlows.length === 0 ? (
                <div style={{ background: '#fff', borderRadius: 12, border: '2px dashed #e2e8f0', padding: '48px', textAlign: 'center' }}>
                  <div style={{ fontSize: 40, marginBottom: 12 }}>🎬</div>
                  <div style={{ fontSize: 16, fontWeight: 600, color: '#0f172a', marginBottom: 6 }}>Nenhum fluxo gravado</div>
                  <div style={{ fontSize: 13, color: '#64748b' }}>Use a extensão Chrome → aba "Gravar Fluxo" para gravar uma jornada</div>
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16 }}>
                  {recordedFlows.map(f => (
                    <div key={f.id} style={{ background: '#fff', borderRadius: 12, border: '1px solid #e2e8f0', padding: '20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                        <div>
                          <div style={{ fontSize: 15, fontWeight: 600, color: '#0f172a' }}>{f.nome}</div>
                          <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>{f.actionCount} ações · {f.createdAt ? new Date(f.createdAt).toLocaleDateString('pt-BR') : ''}</div>
                        </div>
                        <span style={{ fontSize: 20 }}>🎬</span>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 'auto' }}>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button onClick={() => runRecordedFlow(f)} disabled={!!runningFlow} title="Reproduz com Playwright" style={{ flex: 1, padding: '7px 4px', borderRadius: 7, border: 'none', background: runningFlow === f.id ? '#64748b' : ACCENT, color: '#fff', cursor: runningFlow === f.id ? 'not-allowed' : 'pointer', fontSize: 11, fontWeight: 600 }}>
                            {runningFlow === f.id ? '⏳' : '▶'} Playwright
                          </button>
                          <button onClick={() => validateSnapshot(f)} disabled={!!runningFlow} title="Valida snapshot gravado direto, sem browser" style={{ flex: 1, padding: '7px 4px', borderRadius: 7, border: 'none', background: runningFlow === f.id + '-snapshot' ? '#64748b' : '#0f766e', color: '#fff', cursor: runningFlow ? 'not-allowed' : 'pointer', fontSize: 11, fontWeight: 600 }}>
                            {runningFlow === f.id + '-snapshot' ? '⏳' : '📸'} Snapshot
                          </button>
                          <button onClick={() => importAndRunRecorder(f)} disabled={!!runningFlow} title="Importa JSON do Chrome DevTools Recorder e executa" style={{ flex: 1, padding: '7px 4px', borderRadius: 7, border: 'none', background: runningFlow === f.id + '-recorder' ? '#64748b' : '#7c3aed', color: '#fff', cursor: runningFlow ? 'not-allowed' : 'pointer', fontSize: 11, fontWeight: 600 }}>
                            {runningFlow === f.id + '-recorder' ? '⏳' : '🔴'} Recorder
                          </button>
                          <button onClick={e => deleteRecordedFlow(e, f)} style={{ padding: '7px 10px', borderRadius: 7, border: '1px solid #fecaca', background: '#fff', color: '#dc2626', cursor: 'pointer', fontSize: 11 }}>🗑</button>
                        </div>
                        <div style={{ fontSize: 10, color: '#64748b', lineHeight: 1.4 }}>
                          📸 valida sessão gravada · 🔴 importa Chrome Recorder JSON
                        </div>
                      </div>
                      {!!runningFlow && runningFlow.startsWith(f.id) && (
                        <div style={{ fontSize: 11, color: '#15803d', padding: '6px 10px', background: '#f0fdf4', borderRadius: 6 }}>⏳ Resultado aparecerá em "Sessões"</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ══ SESSÕES ══ */}
          {activeNav === 'sessoes' && (
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
              {/* Sidebar de pastas */}
              <div style={{ width: 200, flexShrink: 0, background: '#fff', border: `1.5px solid ${ACCENT}30`, borderRadius: 12, padding: 10, position: 'sticky', top: 0, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: ACCENT, textTransform: 'uppercase', padding: '4px 10px 8px', letterSpacing: 0.5 }}>📁 Pastas</div>
                <div onClick={() => setPastaAtiva(null)} style={{ padding: '10px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: pastaAtiva === null ? 700 : 500, color: pastaAtiva === null ? '#fff' : '#0f172a', background: pastaAtiva === null ? ACCENT : '#f8fafc', marginBottom: 6, display: 'flex', justifyContent: 'space-between' }}>
                  <span>📋 Sem pasta</span>
                  <span style={{ opacity: 0.8, fontWeight: 400 }}>({sessions.filter(s => !s.pasta).length})</span>
                </div>
                {pastas.map(p => {
                  const count = sessions.filter(s => s.pasta === p).length
                  const ativo = pastaAtiva === p
                  return (
                    <div key={p} onClick={() => setPastaAtiva(p)} style={{ padding: '10px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: ativo ? 700 : 500, color: ativo ? '#fff' : '#0f172a', background: ativo ? ACCENT : '#f8fafc', marginBottom: 6, display: 'flex', justifyContent: 'space-between' }}>
                      <span>📁 {p}</span>
                      <span style={{ opacity: 0.8, fontWeight: 400 }}>{count}</span>
                    </div>
                  )
                })}
                {pastas.length === 0 && (
                  <div style={{ padding: '8px 12px', fontSize: 12, color: '#64748b', lineHeight: 1.5 }}>Use o botão 📁 em uma sessão para criar a primeira pasta.</div>
                )}
              </div>

              {/* Lista de sessões */}
              <div style={{ flex: 1, minWidth: 0 }}>
              {(pastaAtiva === null ? sessions.filter(s => !s.pasta) : sessions.filter(s => s.pasta === pastaAtiva)).length === 0 ? (
                <div style={{ background: '#fff', borderRadius: 12, border: '2px dashed #e2e8f0', padding: '48px', textAlign: 'center' }}>
                  <div style={{ fontSize: 40, marginBottom: 12 }}>📡</div>
                  <div style={{ fontSize: 16, fontWeight: 600, color: '#0f172a', marginBottom: 6 }}>{pastaAtiva ? 'Nenhuma sessão nesta pasta' : 'Nenhuma sessão sem pasta'}</div>
                  <div style={{ fontSize: 13, color: '#64748b' }}>{pastaAtiva ? 'Mova sessões para cá usando o botão 📁' : 'Todas as sessões já estão organizadas em pastas — selecione uma pasta ao lado'}</div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {(pastaAtiva === null ? sessions.filter(s => !s.pasta) : sessions.filter(s => s.pasta === pastaAtiva)).map(s => {
                    const isOpen = selectedSession === s.id
                    return (
                      <div key={s.id} style={{ background: '#fff', border: isOpen ? `2px solid ${ACCENT}` : '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden', transition: 'border-color .15s' }}>
                        {/* Cabeçalho clicável do card */}
                        <div
                          onClick={() => isOpen ? (setSelectedSession(null), setSessionDetail(null)) : loadSession(s.id)}
                          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', cursor: 'pointer', userSelect: 'none', background: isOpen ? '#f0f7ff' : '#fff' }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
                            <span style={{ fontSize: 13, color: isOpen ? ACCENT : '#64748b', flexShrink: 0 }}>{isOpen ? '▼' : '▶'}</span>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>{s.nome}</div>
                              {s.testador && s.testador !== 'Não informado' && (
                                <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                                  👤 {s.testador} · {s.timestamp ? new Date(s.timestamp).toLocaleString('pt-BR') : ''}
                                </div>
                              )}
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                            {s.ambiente === 'app'
                              ? <Badge bg='#f5f3ff' color='#7c3aed'><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="phone" size={11} /> app</span></Badge>
                              : <Badge bg='#eff6ff' color='#2563eb'><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="globe" size={11} /> web</span></Badge>}
                            <Badge bg='#eff6ff' color='#2563eb'>{s.dlCount} DL</Badge>
                            <Badge bg='#f0fdf4' color='#15803d'>{s.ga4Count} GA4</Badge>
                            {(s.validacao?.erros ?? 0) > 0
                              ? <Badge bg='#fef2f2' color='#dc2626'>{s.validacao.erros} erros</Badge>
                              : <Badge bg='#f0fdf4' color='#15803d'><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="check" size={11} /> válido</span></Badge>}
                            <button onClick={e => { e.stopPropagation(); exportPDF(s) }} disabled={exportando === s.id} style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, border: '1px solid #bfdbfe', background: '#eff6ff', cursor: 'pointer', color: ACCENT }}>
                              {exportando === s.id ? '...' : '📄 PDF'}
                            </button>
                            {s.nome?.includes('(auto)') && s._fromFlow && (
                              <button onClick={e => { e.stopPropagation(); loadFlowLog(marcaAtiva.id, s._fromFlow) }} style={{ fontSize: 11, padding: '4px 8px', borderRadius: 6, border: '1px solid #bfdbfe', background: '#eff6ff', cursor: 'pointer', color: '#2563eb' }}>
                                📋 Log
                              </button>
                            )}
                            <button onClick={e => { e.stopPropagation(); healthSessionId === s.id ? unsetHealthSession() : setHealthSession(s.id) }} title={healthSessionId === s.id ? 'Remover como sessão de saúde' : 'Definir como sessão de saúde'} style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, border: healthSessionId === s.id ? '1.5px solid #15803d' : '1px solid #bbf7d0', background: healthSessionId === s.id ? '#dcfce7' : '#f0fdf4', cursor: 'pointer', color: '#15803d', fontWeight: healthSessionId === s.id ? 700 : 400 }}>
                              {healthSessionId === s.id ? '❤️ saúde' : '❤️'}
                            </button>
                            <button onClick={e => deleteSession(e, s)} disabled={deletingSession === s.id} style={{ fontSize: 11, padding: '4px 8px', borderRadius: 6, border: '1px solid #fecaca', background: '#fff', cursor: 'pointer', color: '#dc2626' }}>
                              {deletingSession === s.id ? '...' : '🗑'}
                            </button>
                            <div style={{ position: 'relative' }}>
                              <button onClick={e => { e.stopPropagation(); setMovendoSessao(movendoSessao === s.id ? null : s.id) }} title="Mover para pasta" style={{ fontSize: 11, padding: '4px 8px', borderRadius: 6, border: '1px solid #e2e8f0', background: s.pasta ? '#f5f3ff' : '#fff', cursor: 'pointer', color: s.pasta ? '#7c3aed' : '#64748b' }}>
                                📁{s.pasta ? ` ${s.pasta}` : ''}
                              </button>
                              {movendoSessao === s.id && (
                                <div onClick={e => e.stopPropagation()} style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.1)', zIndex: 10, minWidth: 160, padding: 4 }}>
                                  {s.pasta && (
                                    <div onClick={() => moverSessaoParaPasta(null, s, null)} style={{ padding: '6px 10px', fontSize: 12, color: '#dc2626', cursor: 'pointer', borderRadius: 6 }}>✕ Remover da pasta</div>
                                  )}
                                  {pastas.filter(p => p !== s.pasta).map(p => (
                                    <div key={p} onClick={() => moverSessaoParaPasta(null, s, p)} style={{ padding: '6px 10px', fontSize: 12, color: '#0f172a', cursor: 'pointer', borderRadius: 6 }}>📁 {p}</div>
                                  ))}
                                  <div onClick={() => criarPastaEMover(null, s)} style={{ padding: '6px 10px', fontSize: 12, color: ACCENT, cursor: 'pointer', borderRadius: 6, borderTop: pastas.length > 0 ? '1px solid #f1f5f9' : 'none', marginTop: pastas.length > 0 ? 4 : 0 }}>+ Nova pasta</div>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Detalhe inline — aparece dentro do card ao clicar */}
                        {isOpen && (
                          <div style={{ borderTop: `2px solid ${ACCENT}` }}>
                            {loadingSession ? (
                              <div style={{ padding: '28px', textAlign: 'center', color: '#64748b', fontSize: 13 }}>
                                Carregando...
                              </div>
                            ) : sessionDetail ? (() => {
                              const subTab = expandedSessionTab ?? 'resumo'
                              // "custom_view_cart" (nome interno do DL) e "view_cart" (nome que chega no GA4) são
                              // o mesmo evento — normaliza tirando o prefixo pra um nome só aparecer no filtro
                              // e casar dos dois lados, em vez da pessoa ter que adivinhar qual dos dois escolher.
                              const normalizarNomeEvento = nome => nome?.startsWith('custom_') ? nome.slice(7) : nome
                              const nomesEventos = [...new Set([
                                ...(sessionDetail.validacao?.eventos ?? []).map(ev => ev.event ?? ev.name),
                                ...(sessionDetail.ga4Events ?? []).map(ev => ev.event?.event_name ?? ev.event_name),
                              ].filter(Boolean).map(normalizarNomeEvento))].sort()
                              // "Só com problema": olha os dois lados (dataLayer E o veredito de GA4 desse
                              // mesmo disparo) — um evento só é "sem problema" se AMBOS os lados passaram,
                              // senão o filtro escondia justamente o caso que motivou essa checagem dupla
                              // (dataLayer ok, GA4 não confirmou).
                              const temProblema = ev => {
                                if ((ev.errors?.length ?? 0) > 0) return true
                                const g4 = ev.ga4
                                if (!g4) return false
                                return g4.status === 'ausente' || (g4.errors?.length ?? 0) > 0
                              }
                              const qtdProblemas = (sessionDetail.validacao?.eventos ?? []).filter(temProblema).length
                              return (
                                <div>
                                  {/* Sub-tabs */}
                                  <div style={{ display: 'flex', borderBottom: '1px solid #f1f5f9', padding: '0 24px', alignItems: 'center' }}>
                                    {[{ key: 'resumo', label: '📋 Resumo' }, { key: 'detalhe', label: '🔍 Detalhamento' }, { key: 'parceiros', label: '🤝 Parceiros' }].map(t => (
                                      <button key={t.key} onClick={e => { e.stopPropagation(); setExpandedSessionTab(t.key) }} style={{ padding: '14px 16px', fontSize: 13, fontWeight: subTab === t.key ? 600 : 400, border: 'none', background: 'none', cursor: 'pointer', borderBottom: subTab === t.key ? `2px solid ${ACCENT}` : '2px solid transparent', color: subTab === t.key ? ACCENT : '#64748b', marginBottom: -1 }}>
                                        {t.label}
                                      </button>
                                    ))}
                                    {subTab === 'detalhe' && nomesEventos.length > 0 && (
                                      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, marginRight: 12 }}>
                                        <button onClick={() => setSoComProblema(v => !v)} title="Mostrar só disparos com erro no dataLayer ou sem confirmação real no GA4" style={{ fontSize: 12, padding: '6px 10px', borderRadius: 8, border: `1px solid ${soComProblema ? '#dc2626' : '#e2e8f0'}`, color: soComProblema ? '#dc2626' : '#334155', background: soComProblema ? '#fef2f2' : '#fff', cursor: 'pointer', fontWeight: soComProblema ? 600 : 400, whiteSpace: 'nowrap' }}>
                                          {soComProblema ? `⚠ Só com problema (${qtdProblemas})` : '⚠ Só com problema'}
                                        </button>
                                        <select value={eventoFiltro} onChange={e => setEventoFiltro(e.target.value)} style={{ fontSize: 12, padding: '6px 10px', borderRadius: 8, border: '1px solid #e2e8f0', color: '#334155', background: '#fff', cursor: 'pointer' }}>
                                          <option value="">Todos os eventos</option>
                                          {nomesEventos.map(nome => <option key={nome} value={nome}>{nome}</option>)}
                                        </select>
                                      </div>
                                    )}
                                    <button onClick={e => { e.stopPropagation(); exportPDF({ id: selectedSession, nome: sessionDetail.nome }) }} disabled={exportando === selectedSession} style={{ marginLeft: subTab === 'detalhe' && nomesEventos.length > 0 ? 0 : 'auto', fontSize: 12, padding: '6px 14px', borderRadius: 8, border: `1px solid ${ACCENT}`, background: ACCENT_LIGHT, cursor: 'pointer', color: ACCENT, fontWeight: 500 }}>
                                      {exportando === selectedSession ? 'Gerando...' : '📄 Exportar PDF'}
                                    </button>
                                  </div>

                                  <div style={{ padding: '24px' }}>
                                    {/* RESUMO */}
                                    {subTab === 'resumo' && (() => {
                                      const erros       = sessionDetail.validacao?.summary?.failed ?? 0
                                      const incs        = sessionDetail.inconsistencias?.length ?? 0
                                      const GTM_INTERNOS = new Set(['gtm.linkClick','gtm.click','gtm.scrollDepth','gtm.formSubmit','gtm.pageError','gtm.dom','gtm.load','gtm.js','gtm.historyChange','gtm.historyChange-v2','gtm.elementVisibility','gtm.timer','virtual_pageview','deco','OneTrustLoaded','OptanonLoaded','OneTrustGroupsUpdated','view_category'])
                                      const eventosCobertos = new Set(
                                        (sessionDetail.comparacao ?? [])
                                          .filter(c => c.status === 'ok' || c.status === 'divergencias')
                                          .map(c => c.ga4Event ?? c.dlEvent)
                                      )
                                      const semGA4      = (sessionDetail.comparacao ?? []).filter(c => {
                                        if (c.status !== 'nao_chegou_ga4') return false
                                        if (c.noSchema) return false
                                        if (GTM_INTERNOS.has(c.dlEvent)) return false
                                        if (c.dlEvent?.startsWith('gtm.')) return false
                                        // custom_X: oculta apenas se o base event X já chegou ao GA4
                                        if (c.dlEvent?.startsWith('custom_')) {
                                          const base = c.dlEvent.replace('custom_', '')
                                          if (eventosCobertos.has(base)) return false
                                        }
                                        return true
                                      })
                                      const totalErros  = erros + incs + semGA4.length
                                      const isOk        = totalErros === 0
                                      return (
                                        <div>
                                          <div style={{ padding: '16px 20px', borderRadius: 10, background: isOk ? '#f0fdf4' : '#fef2f2', border: `1px solid ${isOk ? '#bbf7d0' : '#fecaca'}`, marginBottom: 20, display: 'flex', alignItems: 'center', gap: 12 }}>
                                            <span style={{ fontSize: 28 }}>{isOk ? '✅' : '❌'}</span>
                                            <div>
                                              <div style={{ fontSize: 15, fontWeight: 700, color: isOk ? '#15803d' : '#dc2626' }}>{isOk ? 'Sessão aprovada' : 'Requer atenção'}</div>
                                              <div style={{ fontSize: 13, color: isOk ? '#15803d' : '#ef4444', marginTop: 2 }}>
                                                {erros} erro(s) de schema · {incs} inconsistência(s) · {semGA4.length} não enviado(s) ao GA4
                                              </div>
                                            </div>
                                          </div>
                                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 12, marginBottom: 20 }}>
                                            {[
                                              { label: 'Eventos DL',      value: sessionDetail.validacao?.summary?.total  ?? 0, color: '#0f172a', bg: '#f8fafc' },
                                              { label: 'Passaram',        value: sessionDetail.validacao?.summary?.passed ?? 0, color: '#15803d', bg: '#f0fdf4' },
                                              { label: 'Erros schema',    value: erros,    color: erros > 0 ? '#dc2626' : '#64748b', bg: erros > 0 ? '#fef2f2' : '#f8fafc' },
                                              { label: 'Inconsistências', value: incs,     color: incs > 0 ? '#d97706' : '#64748b', bg: incs > 0 ? '#fffbeb' : '#f8fafc' },
                                              { label: 'Sem GA4',         value: semGA4.length, color: semGA4.length > 0 ? '#7c3aed' : '#64748b', bg: semGA4.length > 0 ? '#f5f3ff' : '#f8fafc' },
                                            ].map(m => (
                                              <div key={m.label} style={{ background: m.bg, borderRadius: 10, padding: '14px 16px', textAlign: 'center' }}>
                                                <div style={{ fontSize: 24, fontWeight: 700, color: m.color }}>{m.value}</div>
                                                <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>{m.label}</div>
                                              </div>
                                            ))}
                                          </div>
                                          {incs > 0 && (
                                            <div style={{ marginBottom: 16 }}>
                                              <div style={{ ...colHeader, color: '#dc2626', marginBottom: 10 }}>inconsistências entre eventos</div>
                                              {sessionDetail.inconsistencias.map((inc, i) => (
                                                <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, padding: '10px 14px', background: '#fef2f2', borderRadius: 8, marginBottom: 8, border: '1px solid #fecaca' }}>
                                                  <div><div style={{ fontSize: 11, color: '#dc2626', marginBottom: 2 }}>{inc.item_name} <span style={{ opacity: .6 }}>({inc.campo})</span></div><div style={{ fontSize: 12 }}><strong>{inc.evento_origem}</strong>: "{inc.valor_origem}"</div></div>
                                                  <div><div style={{ fontSize: 11, color: '#dc2626', marginBottom: 2 }}>→ diverge em</div><div style={{ fontSize: 12 }}><strong>{inc.evento_atual}</strong>: "{inc.valor_atual}"</div></div>
                                                </div>
                                              ))}
                                            </div>
                                          )}
                                          {semGA4.length > 0 && (
                                            <div style={{ marginBottom: 16 }}>
                                              <div style={{ ...colHeader, color: '#7c3aed', marginBottom: 10 }}>🚫 dataLayer disparado — não enviado ao GA4 <span style={{ fontSize: 11, fontWeight: 400, color: '#64748b' }}>(verificar implementação GTM)</span></div>
                                              {semGA4.map((ev, i) => (
                                                <div key={i} style={{ padding: '10px 14px', background: '#f5f3ff', borderRadius: 8, marginBottom: 6, border: '1px solid #ddd6fe', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                                  <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#5b21b6' }}>{ev.dlEvent}</span>
                                                  <span style={{ fontSize: 11, color: '#7c3aed' }}>DL ✓ → GA4 ✗</span>
                                                </div>
                                              ))}
                                            </div>
                                          )}
                                          {erros > 0 && (
                                            <div>
                                              <div style={{ ...colHeader, color: '#dc2626', marginBottom: 10 }}>eventos com erro de schema</div>
                                              {sessionDetail.validacao.eventos.filter(ev => ev.errors?.length > 0).map((ev, i) => (
                                                <div key={i} style={{ padding: '10px 14px', background: '#fef2f2', borderRadius: 8, marginBottom: 8, border: '1px solid #fecaca' }}>
                                                  <div style={{ fontSize: 13, fontWeight: 600, color: '#dc2626', marginBottom: 6 }}>❌ {ev.event}</div>
                                                  {ev.errors.map((e, j) => <div key={j} style={{ fontSize: 12, color: '#ef4444' }}>• {e}</div>)}
                                                </div>
                                              ))}
                                            </div>
                                          )}
                                          {/* ── Pares view_promotion ↔ select_promotion ── */}
                                          {(() => {
                                            const pares = (sessionDetail.comparacao ?? []).filter(c => c.dlPar === 'view_promotion' && c.dlEvent === 'select_promotion')
                                            if (pares.length === 0) return null
                                            const temDivs = pares.some(p => p.divergencias?.length > 0)
                                            return (
                                              <div style={{ marginBottom: 16 }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                                                  <div style={{ ...colHeader, color: temDivs ? '#d97706' : '#0f172a', marginBottom: 0 }}>
                                                    {temDivs ? '⚠️' : '✅'} pares view_promotion ↔ select_promotion ({pares.length})
                                                  </div>
                                                  <button
                                                    onClick={async () => {
                                                      try {
                                                        const sessaoFiltrada = {
                                                          ...sessionDetail,
                                                          nome: sessionDetail.nome + ' · Pares Promotion',
                                                          ga4Events: [],
                                                          validacao: { summary: { total: pares.length, passed: pares.filter(p => p.status === 'ok').length, failed: pares.filter(p => p.divergencias?.length > 0).length, unknown: 0, erros: pares.filter(p => p.divergencias?.length > 0).length }, eventos: [] },
                                                          inconsistencias: pares.filter(p => p.divergencias?.length > 0).map(p => ({
                                                            item_name: p.promocao,
                                                            item_id: 'promotion',
                                                            campo: p.divergencias?.join(' | ') ?? '',
                                                            evento_origem: 'view_promotion',
                                                            valor_origem: p.nota ?? '',
                                                            evento_atual: 'select_promotion',
                                                            valor_atual: p.divergencias?.join(', ') ?? 'ok',
                                                          })),
                                                          comparacao: pares,
                                                          _filtro: 'view_promotion ↔ select_promotion',
                                                        }
                                                        const resp = await fetch(`${API}/api/sessions/pdf-custom`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sessaoFiltrada) })
                                                        const blob = await resp.blob()
                                                        const url = URL.createObjectURL(blob)
                                                        const a = document.createElement('a')
                                                        a.href = url; a.download = `pares-promotion-${sessionDetail.nome?.replace(/\s+/g,'-')}.pdf`
                                                        a.click(); URL.revokeObjectURL(url)
                                                      } catch (e) { alert('Erro ao gerar PDF: ' + e.message) }
                                                    }}
                                                    style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, border: `1px solid #e2e8f0`, background: '#f8fafc', cursor: 'pointer', color: '#475569', whiteSpace: 'nowrap' }}
                                                  >
                                                    📄 Exportar PDF
                                                  </button>
                                                </div>
                                                {pares.map((par, i) => {
                                                  const temDiv = par.divergencias?.length > 0
                                                  return (
                                                    <div key={i} style={{ padding: '12px 14px', background: temDiv ? '#fffbeb' : '#f0fdf4', borderRadius: 8, marginBottom: 8, border: `1px solid ${temDiv ? '#fde68a' : '#bbf7d0'}` }}>
                                                      <div style={{ fontSize: 12, fontWeight: 600, color: temDiv ? '#92400e' : '#15803d', marginBottom: 4 }}>
                                                        {temDiv ? '⚠️' : '✅'} {par.promocao}
                                                      </div>
                                                      {temDiv
                                                        ? par.divergencias.map((d, j) => <div key={j} style={{ fontSize: 11, color: '#b45309' }}>• {d}</div>)
                                                        : <div style={{ fontSize: 11, color: '#15803d' }}>Parâmetros idênticos entre view e select</div>
                                                      }
                                                    </div>
                                                  )
                                                })}
                                              </div>
                                            )
                                          })()}
                                          {isOk && <div style={{ padding: '14px', background: '#f0fdf4', borderRadius: 8, color: '#15803d', fontSize: 13 }}>✅ Nenhum problema encontrado nesta sessão</div>}
                                        </div>
                                      )
                                    })()}

                                    {/* DETALHAMENTO */}
                                    {subTab === 'parceiros' && (() => {
                            const parcs = sessionDetail.parceiros ?? []
                            const porParceiro = parcs.reduce((acc, h) => { acc[h.parceiro] = acc[h.parceiro] || []; acc[h.parceiro].push(h); return acc; }, {})
                            return (
                              <div>
                                {parcs.length === 0 ? (
                                  <div style={{ padding: 40, textAlign: 'center', color: '#64748b', fontSize: 13 }}>Nenhuma chamada de parceiro capturada nesta sessão.<br/><span style={{ fontSize: 11 }}>Certifique-se de que a extensão foi atualizada com suporte a parceiros.</span></div>
                                ) : Object.entries(porParceiro).map(([parceiro, hits]) => (
                                  <div key={parceiro} style={{ marginBottom: 20 }}>
                                    <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', padding: '10px 0 8px', borderBottom: '2px solid #e2e8f0', marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                      <span>🤝 {parceiro}</span>
                                      <span style={{ fontSize: 11, fontWeight: 400, color: '#64748b' }}>{hits.length} chamada(s)</span>
                                    </div>
                                    {hits.map((h, i) => (
                                      <div key={i} style={{ background: '#f8fafc', borderRadius: 8, padding: '10px 14px', marginBottom: 8, border: '1px solid #e2e8f0' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                                          <span style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 600, color: '#2563eb' }}>{h.evento}</span>
                                          <span style={{ fontSize: 10, color: '#64748b' }}>{new Date(h.timestamp).toLocaleTimeString('pt-BR')}</span>
                                        </div>
                                        <PayloadJSON data={h.payload} style={{ margin: 0, fontSize: 11, color: '#475569', background: '#fff', borderRadius: 6, padding: '8px 10px', border: '1px solid #f1f5f9', overflow: 'auto', maxHeight: 200 }} />
                                      </div>
                                    ))}
                                  </div>
                                ))}
                              </div>
                            )
                          })()}
                          {subTab === 'detalhe' && (
                                    <div>
                                      {/* Comparação DL vs GA4 — o veredito de verdade ("o que o dataLayer prometeu bate
                                          com o que o GA4 recebeu?"), promovida pra cima das duas listas de evidência
                                          crua. Antes ficava embaixo da coluna GA4, obrigando rolar duas listas
                                          inteiras antes de chegar na resposta — a comparação é a resposta, o
                                          dataLayer/GA4 abaixo são só o "mostre seu trabalho". */}
                                      {(() => {
                                        const comparacaoFiltrada = (sessionDetail.comparacao ?? [])
                                          .filter(cmp => !soComProblema || cmp.status !== 'ok')
                                          .filter(cmp => !eventoFiltro || normalizarNomeEvento(cmp.dlEvent) === eventoFiltro || normalizarNomeEvento(cmp.ga4Event) === eventoFiltro)
                                        if (!sessionDetail.comparacao?.length) return null
                                        const comparacaoAberta = expanded['comparacao-secao'] ?? true
                                        return (
                                          <div style={{ marginBottom: 20, border: `1px solid ${STATUS_COLOR.alias.border}`, borderRadius: 10, background: STATUS_COLOR.alias.bg, padding: '14px 16px' }}>
                                            <div role="button" tabIndex={0} aria-expanded={comparacaoAberta} onClick={() => toggleExpanded('comparacao-secao')} onKeyDown={e => onKeyToggle(e, 'comparacao-secao')} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                                              <div style={{ flex: 1 }}>
                                                <div style={{ fontSize: 13, fontWeight: 700, color: STATUS_COLOR.alias.fg, marginBottom: 2 }}>comparação DL vs GA4 — o que realmente chegou</div>
                                                <div style={{ fontSize: 11, color: STATUS_COLOR.alias.fg }}>compara o disparo do dataLayer com o hit real de GA4 dessa mesma sessão — não presume que um é igual ao outro</div>
                                              </div>
                                              <span style={{ fontSize: 11, color: STATUS_COLOR.alias.fg, flexShrink: 0 }}>{comparacaoAberta ? '▲' : '▼'}</span>
                                            </div>
                                            {comparacaoAberta && <div style={{ marginTop: 10 }}>
                                            {comparacaoFiltrada.length === 0 && (
                                              <div style={{ fontSize: 12, color: STATUS_COLOR.alias.fg }}>{soComProblema ? 'Nenhuma divergência com os filtros atuais.' : 'Sem comparações pra mostrar.'}</div>
                                            )}
                                            {comparacaoFiltrada.map((cmp, i) => {
                                              const isOk = cmp.status === 'ok'
                                              const isNc = cmp.status === 'nao_chegou_ga4'
                                              const icon = isOk ? '✅' : isNc ? '🚫' : '⚠'
                                              const bg   = isOk ? STATUS_COLOR.ok.bg : isNc ? STATUS_COLOR.absent.bg : STATUS_COLOR.warn.bg
                                              const bdr  = isOk ? STATUS_COLOR.ok.border : isNc ? STATUS_COLOR.absent.border : STATUS_COLOR.warn.border
                                              const clr  = isOk ? STATUS_COLOR.ok.fg : isNc ? STATUS_COLOR.absent.fg : STATUS_COLOR.warn.fg
                                              const key  = `scmp-${i}`
                                              const hasDivs = (cmp.divergencias?.length > 0 && !isOk) || !!cmp.nota
                                              return (
                                                <div key={i} style={{ border: `1px solid ${bdr}`, borderRadius: 8, overflow: 'hidden', marginBottom: 6, background: '#fff' }}>
                                                  <button onClick={() => hasDivs && toggleExpanded(key)} disabled={!hasDivs} aria-expanded={!!expanded[key]} style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: bg, cursor: hasDivs ? 'pointer' : 'default', border: 'none', font: 'inherit' }}>
                                                    <span>{icon}</span>
                                                    <span style={{ fontSize: 13, fontWeight: 500, flex: 1, color: clr }}>{cmp.dlEvent}{cmp.ga4Event && cmp.ga4Event !== cmp.dlEvent ? ` → ${cmp.ga4Event}` : ''}</span>
                                                    {hasDivs && <span style={{ fontSize: 11, color: '#64748b' }}>{expanded[key] ? '▲' : '▼'}</span>}
                                                  </button>
                                                  {expanded[key] && (
                                                    <div style={{ padding: '8px 12px', borderTop: `1px solid ${bdr}` }}>
                                                      {cmp.divergencias?.map((d, j) => <div key={j} style={{ fontSize: 12, color: clr, padding: '2px 0' }}>{isNc ? '🚫' : '⚠'} {d}</div>)}
                                                      {cmp.nota && <div style={{ fontSize: 11, color: '#64748b', marginTop: 4, padding: '4px 8px', background: '#f8fafc', borderRadius: 4 }}>ℹ️ {cmp.nota}</div>}
                                                    </div>
                                                  )}
                                                </div>
                                              )
                                            })}
                                            </div>}
                                          </div>
                                        )
                                      })()}

                                      {/* Empilha em coluna única abaixo de 900px — sem isso as duas colunas só
                                          espremiam, nunca reorganizavam, e o header de cada card (ícone + nome +
                                          badges + botão ⇄) ficava sem espaço e cortava/sobrepunha. */}
                                      <style>{'@media (max-width: 900px) { .detalhe-colunas { flex-direction: column !important; } }'}</style>
                                      <div className="detalhe-colunas" style={{ display: 'flex', gap: 20 }}>
                                        {/* dataLayer */}
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                          <div style={colHeader}>dataLayer</div>
                                          {sessionDetail.validacao?.eventos?.length === 0 && <div style={{ padding: '12px', borderRadius: 8, background: STATUS_COLOR.warn.bg, color: STATUS_COLOR.warn.fg, fontSize: 12 }}>⚠ Nenhum evento dataLayer capturado</div>}
                                          {sessionDetail.validacao?.eventos?.map((ev, i) => ({ ev, i })).filter(({ ev }) => !soComProblema || temProblema(ev)).filter(({ ev }) => !eventoFiltro || normalizarNomeEvento(ev.event ?? ev.name) === eventoFiltro).map(({ ev, i }) => {
                                            const es  = EVENTO_STATUS[ev.status] ?? EVENTO_STATUS.desconhecido
                                            const key = `sdl-${i}`
                                            const hasDetails = ev.errors?.length > 0 || ev.warnings?.length > 0 || ev.passed?.length > 0
                                            // ev.regiao pode vir de um fallback do validator.js (primeira entrada do
                                            // schema pra esse nome de evento) quando o payload não tem region — nesse
                                            // caso não é o dado real, só mostra o badge se o payload realmente tiver region.
                                            const rawEv       = sessionDetail.dlEvents?.[i]?.event ?? {}
                                            const regiaoReal  = rawEv.region ?? rawEv.ecommerce?.region ?? null
                                            // status "ignorado" cobre dois casos distintos (alias custom_ validado via
                                            // GA4, ou evento de terceiro fora do schema) — a etiqueta deixa claro qual,
                                            // já que o nome exibido some o prefixo custom_ e ficaria igual a outra linha.
                                            const isAliasCustom = ev.status === 'ignorado' && ev.warnings?.some(w => w.startsWith('Alias DL de'))
                                            const isTerceiro     = ev.status === 'ignorado' && ev.warnings?.some(w => w.includes('terceiro'))
                                            // custom_X sem o evento base separado no DL é validado como X, mas mantém
                                            // o nome "custom_X" no rótulo (sem normalizar) — rastreia que os erros/params
                                            // abaixo vieram do alias, não do evento "X" de verdade.
                                            const isAliasValidado = ev.warnings?.some(w => w.startsWith('Validado via alias'))
                                            // user_info/custom_user_info tem checagem própria (não passa pelo schema), mas
                                            // é sempre disparado com o prefixo "custom_" na prática — mantém o nome cru
                                            // igual aos outros casos de alias, pra rastrear a origem do disparo.
                                            const isUserInfoCustom = ev.event === 'custom_user_info'
                                            const mostrarNomeCru = isAliasValidado || isUserInfoCustom
                                            // ev.ga4 existe (mesmo quando é só um placeholder "ausente", sem raw nenhum)
                                            // pra todo evento — inclusive user_info, que nunca chega ao GA4 por natureza.
                                            // Só mostra o botão de pular quando tem um payload de verdade do outro lado,
                                            // senão o botão sugere uma correspondência que não existe.
                                            const temParGA4 = ev.ga4?.raw != null
                                            return (
                                              <div key={i} id={`par-dl-${i}`} style={{ ...eventRow, ...(linkedHighlight === i ? { border: `2px solid ${STATUS_COLOR.alias.fg}` } : {}) }}>
                                                <div role="button" tabIndex={hasDetails ? 0 : -1} aria-expanded={hasDetails ? !!expanded[key] : undefined} onClick={() => hasDetails && toggleExpanded(key)} onKeyDown={e => hasDetails && onKeyToggle(e, key)} style={eventHeader(hasDetails)}>
                                                  <span>{es.icon}</span>
                                                  <span style={{ fontSize: 13, fontWeight: 500, color: es.color }}>{mostrarNomeCru ? (ev.event ?? ev.name) : normalizarNomeEvento(ev.event ?? ev.name)}</span>
                                                  {isAliasCustom && <span title='Esse evento é um alias "custom_" do dataLayer — o mesmo disparo já foi validado no GA4 sob o nome sem o prefixo, então este aqui não é checado de novo.' style={{ fontSize: 10, fontWeight: 600, color: STATUS_COLOR.info.fg, cursor: 'help' }}>via GA4</span>}
                                                  {isTerceiro && <span title="Evento de ferramenta de terceiro (fora do Mapa de Tags) — não é checado contra o schema do Notion." style={{ fontSize: 10, fontWeight: 600, color: STATUS_COLOR.muted.fg, cursor: 'help' }}>terceiro</span>}
                                                  {isAliasValidado && <span title='Nome com prefixo "custom_" do dataLayer, mas validado usando o schema do evento sem o prefixo (o evento "de verdade" não existe separado nesta sessão).' style={{ fontSize: 10, fontWeight: 600, color: STATUS_COLOR.alias.fg, cursor: 'help' }}>alias</span>}
                                                  {isUserInfoCustom && <span title='Nome com prefixo "custom_" do dataLayer — o user_info tem checagem própria (não usa o schema do Notion), mantido aqui só pra rastrear a origem do disparo.' style={{ fontSize: 10, fontWeight: 600, color: STATUS_COLOR.alias.fg, cursor: 'help' }}>alias</span>}
                                                  {regiaoReal && <span style={{ fontSize: 11, color: STATUS_COLOR.muted.fg, fontFamily: 'monospace' }}>{regiaoReal}</span>}
                                                  <span style={{ flex: 1 }} />
                                                  {temParGA4 && <button onClick={e => { e.stopPropagation(); irParaPar(i, 'ga4'); e.currentTarget.blur() }} title="Ver par no GA4 capturado" style={{ fontSize: 11, padding: '6px 10px', minHeight: 28, borderRadius: 5, border: '1px solid #e2e8f0', background: '#fff', color: STATUS_COLOR.muted.fg, cursor: 'pointer', outline: 'none' }}>⇄ GA4</button>}
                                                  {ev.errors?.length > 0 && <span style={badge(STATUS_COLOR.error.bg, STATUS_COLOR.error.fg)}>{ev.errors.length} erro(s)</span>}
                                                  {ev.warnings?.length > 0 && <span style={badge(STATUS_COLOR.warn.bg, STATUS_COLOR.warn.fg)}>{ev.warnings.length} aviso(s)</span>}
                                                  {ev.passed?.length > 0 && <span style={badge(STATUS_COLOR.ok.bg, STATUS_COLOR.ok.fg)}>{ev.passed.length} ok</span>}
                                                  {hasDetails && <span style={{ fontSize: 11, color: STATUS_COLOR.muted.fg }}>{expanded[key] ? '▲' : '▼'}</span>}
                                                </div>
                                                {expanded[key] && (
                                                  <div style={{ padding: '8px 10px', borderTop: '1px solid #f1f5f9', background: '#f8fafc' }}>
                                                    {ev.errors?.map((e, j) => <div key={j} style={{ fontSize: 12, color: STATUS_COLOR.error.fg, padding: '2px 0' }}>❌ {e}</div>)}
                                                    {ev.warnings?.map((w, j) => <div key={j} style={{ fontSize: 12, color: STATUS_COLOR.warn.fg, padding: '2px 0' }}>⚠ {w}</div>)}
                                                    {ev.passed?.map((p, j) => <div key={j} style={{ fontSize: 12, color: STATUS_COLOR.ok.fg, padding: '2px 0' }}>✅ {p}</div>)}
                                                    {sessionDetail.dlEvents?.[i] && (
                                                      <>
                                                        <div style={{ fontSize: 10, color: '#64748b', marginTop: 8, marginBottom: 4, textTransform: 'uppercase', fontWeight: 600 }}>payload</div>
                                                        <PayloadJSON data={sessionDetail.dlEvents[i]} style={{ margin: 0, fontSize: 11, color: '#475569', background: '#fff', borderRadius: 6, padding: '8px 10px', border: '1px solid #f1f5f9', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }} />
                                                      </>
                                                    )}
                                                  </div>
                                                )}
                                              </div>
                                            )
                                          })}

                                          {/* Inconsistências */}
                                          {sessionDetail.inconsistencias?.length > 0 && (
                                            <div style={{ marginTop: 16 }}>
                                              <div style={{ ...colHeader, color: STATUS_COLOR.error.fg, marginBottom: 8 }}>inconsistências entre eventos</div>
                                              {sessionDetail.inconsistencias.map((inc, i) => (
                                                <div key={i} style={{ border: `1px solid ${STATUS_COLOR.error.border}`, borderRadius: 8, overflow: 'hidden', marginBottom: 8 }}>
                                                  <div style={{ padding: '8px 12px', background: STATUS_COLOR.error.bg }}>
                                                    <div style={{ fontSize: 12, fontWeight: 600, color: STATUS_COLOR.error.fg }}>"{inc.item_name}" (id: {inc.item_id})</div>
                                                    <div style={{ fontSize: 11, color: '#ef4444' }}>campo "{inc.campo}" divergente</div>
                                                  </div>
                                                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, padding: '8px 12px', background: '#fff' }}>
                                                    <div style={{ fontSize: 12, padding: '6px 8px', borderRadius: 6, background: '#f8fafc' }}>
                                                      <div style={{ fontSize: 11, color: STATUS_COLOR.muted.fg, marginBottom: 2 }}>{inc.evento_origem}</div>
                                                      <div style={{ fontWeight: 500 }}>"{inc.valor_origem}"</div>
                                                    </div>
                                                    <div style={{ fontSize: 12, padding: '6px 8px', borderRadius: 6, background: STATUS_COLOR.error.bg }}>
                                                      <div style={{ fontSize: 11, color: STATUS_COLOR.error.fg, marginBottom: 2 }}>{inc.evento_atual}</div>
                                                      <div style={{ fontWeight: 500, color: STATUS_COLOR.error.fg }}>"{inc.valor_atual}"</div>
                                                    </div>
                                                  </div>
                                                </div>
                                              ))}
                                            </div>
                                          )}
                                        </div>

                                        {/* GA4 — mesma lista de disparos do dataLayer (à esquerda), cada card mostrando o
                                            veredito do hit de GA4 correspondente a ESSE disparo (achado no back pelo
                                            horário mais próximo). Garante que os dois lados sempre falam do mesmo
                                            disparo, mesmo quando o mesmo evento se repete várias vezes na sessão —
                                            não é mais uma lista independente dos hits de GA4 crus. */}
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                                            <div style={colHeader}>GA4 capturado</div>
                                            {selectedGA4.size > 0 && (
                                              <button onClick={exportPDFSelecionados} disabled={exportando === selectedSession + '_sel'} style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, border: 'none', background: ACCENT, color: '#fff', cursor: 'pointer' }}>
                                                {exportando === selectedSession + '_sel' ? 'Gerando...' : `📄 Exportar ${selectedGA4.size}`}
                                              </button>
                                            )}
                                          </div>
                                          {(() => {
                                            const linhasGA4 = (sessionDetail.validacao?.eventos ?? []).map((ev, i) => ({ ev, i }))
                                              .filter(({ ev }) => ev.ga4 !== null && ev.ga4 !== undefined)
                                              .filter(({ ev }) => !soComProblema || temProblema(ev)).filter(({ ev }) => !eventoFiltro || normalizarNomeEvento(ev.event ?? ev.name) === eventoFiltro)
                                            if (linhasGA4.length === 0) {
                                              return <div style={{ padding: '12px', borderRadius: 8, background: STATUS_COLOR.warn.bg, color: STATUS_COLOR.warn.fg, fontSize: 12 }}>⚠ Nenhum evento GA4 capturado</div>
                                            }
                                            return (
                                              <>
                                                <label style={{ fontSize: 11, color: STATUS_COLOR.muted.fg, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, padding: '4px 0' }}>
                                                  <input type="checkbox" checked={selectedGA4.size === linhasGA4.length} onChange={e => { if (e.target.checked) setSelectedGA4(new Set(linhasGA4.map(({ i }) => i))); else setSelectedGA4(new Set()) }} style={{ width: 16, height: 16 }} />
                                                  Selecionar todos
                                                </label>
                                                {linhasGA4.map(({ ev, i }) => {
                                                  const key  = `sga4-${i}`
                                                  const g4   = ev.ga4
                                                  const es   = EVENTO_STATUS[g4.status] ?? EVENTO_STATUS.desconhecido
                                                  const hasDetails = g4.errors?.length > 0 || g4.warnings?.length > 0 || g4.passed?.length > 0
                                                  const checked = selectedGA4.has(i)
                                                  return (
                                                    <div key={i} id={`par-ga4-${i}`} style={{ ...eventRow, border: linkedHighlight === i ? `2px solid ${STATUS_COLOR.alias.fg}` : `1px solid ${checked ? ACCENT : '#e2e8f0'}`, background: checked ? '#eff6ff' : '#fff' }}>
                                                      <div role="button" tabIndex={hasDetails ? 0 : -1} aria-expanded={hasDetails ? !!expanded[key] : undefined} onClick={() => hasDetails && toggleExpanded(key)} onKeyDown={e => hasDetails && onKeyToggle(e, key)} style={{ ...eventHeader(hasDetails), background: checked ? '#dbeafe' : undefined }}>
                                                        <input type="checkbox" checked={checked} onChange={e => { const next = new Set(selectedGA4); e.target.checked ? next.add(i) : next.delete(i); setSelectedGA4(next) }} onClick={e => e.stopPropagation()} aria-label={`Selecionar ${normalizarNomeEvento(ev.event ?? ev.name)} para exportação`} style={{ cursor: 'pointer', width: 16, height: 16 }} />
                                                        <span>{es.icon}</span>
                                                        <span style={{ fontSize: 13, fontWeight: 500, color: es.color }}>{normalizarNomeEvento(ev.event ?? ev.name)}</span>
                                                        <span style={{ flex: 1 }} />
                                                        <button onClick={e => { e.stopPropagation(); irParaPar(i, 'dl'); e.currentTarget.blur() }} title="Ver par no dataLayer" style={{ fontSize: 11, padding: '6px 10px', minHeight: 28, borderRadius: 5, border: '1px solid #e2e8f0', background: '#fff', color: STATUS_COLOR.muted.fg, cursor: 'pointer', outline: 'none' }}>⇄ DL</button>
                                                        {g4.status === 'ausente' && <span style={{ fontSize: 10, fontWeight: 600, color: STATUS_COLOR.absent.fg }}>não chegou ao GA4</span>}
                                                        {g4.errors?.length > 0 && <span style={badge(STATUS_COLOR.error.bg, STATUS_COLOR.error.fg)}>{g4.errors.length} erro(s)</span>}
                                                        {g4.warnings?.length > 0 && <span style={badge(STATUS_COLOR.warn.bg, STATUS_COLOR.warn.fg)}>{g4.warnings.length} aviso(s)</span>}
                                                        {g4.passed?.length > 0 && <span style={badge(STATUS_COLOR.ok.bg, STATUS_COLOR.ok.fg)}>{g4.passed.length} ok</span>}
                                                        {hasDetails && <span style={{ fontSize: 11, color: STATUS_COLOR.muted.fg }}>{expanded[key] ? '▲' : '▼'}</span>}
                                                      </div>
                                                      {expanded[key] && (
                                                        <div style={{ padding: '8px 10px', borderTop: '1px solid #f1f5f9', background: '#f8fafc' }}>
                                                          {g4.errors?.map((e, j) => <div key={j} style={{ fontSize: 12, color: STATUS_COLOR.error.fg, padding: '2px 0' }}>❌ {e}</div>)}
                                                          {g4.warnings?.map((w, j) => <div key={j} style={{ fontSize: 12, color: STATUS_COLOR.warn.fg, padding: '2px 0' }}>⚠ {w}</div>)}
                                                          {g4.passed?.map((p, j) => <div key={j} style={{ fontSize: 12, color: STATUS_COLOR.ok.fg, padding: '2px 0' }}>✅ {p}</div>)}
                                                          {g4.raw && (
                                                            <>
                                                              <div style={{ fontSize: 10, color: '#64748b', marginTop: 8, marginBottom: 4, textTransform: 'uppercase', fontWeight: 600 }}>payload</div>
                                                              <PayloadJSON data={g4.raw?.event ?? g4.raw} style={{ margin: 0, fontSize: 11, color: '#475569', background: '#fff', borderRadius: 6, padding: '8px 10px', border: '1px solid #f1f5f9', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }} />
                                                            </>
                                                          )}
                                                        </div>
                                                      )}
                                                    </div>
                                                  )
                                                })}
                                              </>
                                            )
                                          })()}
                                        </div>
                                      </div>
                                    </div>
                                    )}
                                  </div>
                                </div>
                              )
                            })() : null}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
              </div>
            </div>
          )}


          {/* ══ CAPTURA AO VIVO — feed de dataLayer em tempo real ══ */}
          {liveFeedOpen && liveSession && (
            <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setLiveFeedOpen(false)}>
              <div style={{ background: '#fff', borderRadius: 12, width: '92%', maxWidth: 1100, height: '82vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }} onClick={e => e.stopPropagation()}>
                <div style={{ padding: '14px 20px', borderBottom: '1px solid #1e293b', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#0f172a', flexShrink: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span className="faro-live-dot" style={{ width: 8, height: 8, borderRadius: '50%', background: '#f87171', flexShrink: 0 }} />
                    <span style={{ color: '#fff', fontWeight: 700, fontSize: 14 }}>Captura ao vivo</span>
                    <span style={{ color: '#94a3b8', fontSize: 12 }}>{liveSession.events.length} evento{liveSession.events.length !== 1 ? 's' : ''}</span>
                  </div>
                  <button onClick={() => setLiveFeedOpen(false)} aria-label="Fechar" style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>✕</button>
                </div>
                <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
                  {/* Lista de disparos — mais recente no topo */}
                  <div style={{ width: 320, flexShrink: 0, borderRight: '1px solid #e2e8f0', overflowY: 'auto', background: '#f8fafc' }}>
                    {liveSession.events.length === 0 ? (
                      <div style={{ padding: '32px 20px', textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>Aguardando disparos — navegue no site sendo testado</div>
                    ) : liveSession.events.map((ev, i) => {
                      const nomeCru = ev?.event?.event ?? '—'
                      const nome    = nomeCru.startsWith('custom_') ? nomeCru.slice(7) : nomeCru
                      const ativo   = liveInspectIndex === i
                      return (
                        <div key={i} role="button" tabIndex={0} onClick={() => setLiveInspectIndex(i)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setLiveInspectIndex(i) } }}
                          style={{ padding: '10px 16px', borderBottom: '1px solid #e2e8f0', cursor: 'pointer', background: ativo ? '#dbeafe' : 'transparent', display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ fontSize: 11, color: '#94a3b8', width: 20, textAlign: 'right', flexShrink: 0 }}>{liveSession.events.length - i}</span>
                          <span style={{ fontSize: 13, fontWeight: 500, color: '#0f172a', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nome}</span>
                        </div>
                      )
                    })}
                  </div>
                  {/* Payload do disparo selecionado */}
                  <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
                    {liveSession.events[liveInspectIndex] ? (() => {
                      const sel     = liveSession.events[liveInspectIndex]
                      const nomeCru = sel?.event?.event ?? '—'
                      const nome    = nomeCru.startsWith('custom_') ? nomeCru.slice(7) : nomeCru
                      return (
                        <>
                          <div style={{ fontSize: 17, fontWeight: 700, color: '#0f172a', marginBottom: 2 }}>{nome}</div>
                          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 18 }}>dataLayer · {sel.timestamp ? new Date(sel.timestamp).toLocaleTimeString('pt-BR') : ''}</div>
                          <PayloadJSON data={sel.event ?? sel} style={{ margin: 0, fontSize: 12, color: '#334155', background: '#f8fafc', borderRadius: 8, padding: '16px 18px', border: '1px solid #e2e8f0', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }} />
                        </>
                      )
                    })() : (
                      <div style={{ color: '#94a3b8', fontSize: 13, textAlign: 'center', marginTop: 60 }}>Selecione um disparo à esquerda pra ver o payload</div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ══ LOG MODAL ══ */}
          {flowLog && (
            <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setFlowLog(null)}>
              <div style={{ background: '#0f172a', borderRadius: 12, width: '80%', maxWidth: 900, maxHeight: '80vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
                <div style={{ padding: '14px 20px', borderBottom: '1px solid #1e293b', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ color: '#e2e8f0', fontWeight: 600, fontSize: 13 }}>📋 Log de Execução Playwright</span>
                  <button onClick={() => setFlowLog(null)} style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 18 }}>✕</button>
                </div>
                <div style={{ overflow: 'auto', padding: '16px 20px', flex: 1 }}>
                  {(flowLog.logs ?? []).map((line, i) => (
                    <div key={i} style={{ fontFamily: 'monospace', fontSize: 12, color: line.includes('✓') ? '#4ade80' : line.includes('✗') || line.includes('❌') ? '#f87171' : line.includes('·') ? '#64748b' : '#e2e8f0', padding: '2px 0', whiteSpace: 'pre-wrap' }}>
                      {line}
                    </div>
                  ))}
                  {flowLog.logs?.length === 0 && <div style={{ color: '#64748b', fontSize: 13 }}>Log vazio ou execução em andamento</div>}
                </div>
              </div>
            </div>
          )}

          {/* ══ SAÚDE DO TRACKING ══ */}
          {activeNav === 'saude' && (
            <div>
              {/* ── OVERVIEW ── */}
              {healthSubView === 'overview' && (
                <HealthOverview
                  healthOverview={healthOverview}
                  healthOverviewLoading={healthOverviewLoading}
                  healthMarcasFiltro={healthMarcasFiltro}
                  onChangeFiltro={setHealthMarcasFiltro}
                  onReload={() => {
                    setHealthOverviewLoading(true)
                    axios.get(`${API}/api/health/overview`).then(({ data }) => setHealthOverview(data)).finally(() => setHealthOverviewLoading(false))
                  }}
                  onSelectMarca={(marcaId) => {
                    axios.get(`${API}/api/marcas`).then(({ data }) => {
                      const mm = data.find(x => x.id === marcaId)
                      if (mm) { setMarcaAtiva(mm); setHealthSubView('marca'); setTimeout(loadHealth, 100) }
                    })
                  }}
                />
              )}

              {/* -- SAUDE DA MARCA -- */}
              {healthSubView === 'marca' && (
                <HealthMarca
                  marcaAtiva={marcaAtiva}
                  healthLoading={healthLoading}
                  healthResultLoading={healthResultLoading}
                  healthResult={healthResult}
                  onBack={() => setHealthSubView('overview')}
                />
              )}
            </div>
          )}


          {/* ══ INSTRUÇÕES ══ */}
          {activeNav === 'instrucoes' && (
            <div style={{ maxWidth: 760 }}>
              {/* Download card */}
              <div style={{ background: 'linear-gradient(135deg, #1e3a5f 0%, #2563eb 100%)', borderRadius: 12, padding: '24px 28px', marginBottom: 24, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: '#fff', marginBottom: 4 }}>📦 Extensão Faro</div>
                  <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.75)' }}>Baixe e instale a extensão Chrome para começar a capturar eventos</div>
                </div>
                <a href="/api/download-extensao" download="faro-extensao.zip" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 22px', borderRadius: 10, background: '#fff', color: ACCENT, fontWeight: 700, fontSize: 14, textDecoration: 'none', whiteSpace: 'nowrap', boxShadow: '0 4px 12px rgba(0,0,0,0.15)' }}>
                  ⬇️ Baixar extensão
                </a>
              </div>
              {[
                {
                  num: '01', title: 'Baixar a extensão',
                  desc: 'Faça o download do arquivo ZIP da extensão Faro e descompacte em uma pasta no seu computador.',
                  steps: ['Acesse o repositório da extensão', 'Baixe o arquivo extensao-v2.zip', 'Descompacte em uma pasta de fácil acesso'],
                  icon: '📦',
                },
                {
                  num: '02', title: 'Instalar no Chrome',
                  desc: 'A extensão precisa ser instalada em modo desenvolvedor no Google Chrome.',
                  steps: ['Abra o Chrome e acesse chrome://extensions', 'Ative o "Modo do desenvolvedor" (canto superior direito)', 'Clique em "Carregar sem compactação"', 'Selecione a pasta da extensão descompactada'],
                  icon: '🔧',
                },
                {
                  num: '03', title: 'Configurar a extensão',
                  desc: 'Antes de usar, configure a URL do servidor Faro e o domínio sGTM da marca.',
                  steps: [
                    `URL do servidor: ${window.location.origin}`,
                    'Domínio sGTM: ex: sgtm.marca-f.exemplo.com.br (encontre nas configs de cada marca)',
                    'Clique em "Iniciar captura" para começar',
                  ],
                  icon: '⚙️',
                },
                {
                  num: '04', title: 'Capturar uma sessão',
                  desc: 'Use a aba "📡 Sessão" para capturar eventos em tempo real.',
                  steps: ['Preencha URL do servidor e domínio sGTM', 'Clique em "Iniciar captura"', 'Navegue normalmente no site da marca', 'Clique em "Parar captura"', 'Preencha nome do testador, sessão e marca, e salve'],
                  icon: '📡',
                },
                {
                  num: '05', title: 'Gravar um fluxo reutilizável',
                  desc: 'Use a aba "🎬 Gravar Fluxo" para gravar uma jornada que pode ser reproduzida automaticamente.',
                  steps: ['Preencha URL do servidor, marca e domínio sGTM', 'Clique em "Iniciar gravação"', 'Navegue pelo fluxo desejado (home → banner → produto → carrinho)', 'Clique em "Parar gravação"', 'Dê um nome ao fluxo e salve', 'No dashboard → Fluxos Gravados → clique "▶ Rodar"'],
                  icon: '🎬',
                },
              ].map((step, i) => (
                <div key={i} style={{ background: '#fff', borderRadius: 12, border: '1px solid #e2e8f0', padding: '24px', marginBottom: 16, display: 'flex', gap: 20 }}>
                  <div style={{ width: 48, height: 48, borderRadius: 12, background: ACCENT, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, flexShrink: 0 }}>{step.icon}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: ACCENT, background: ACCENT_LIGHT, padding: '2px 8px', borderRadius: 6 }}>{step.num}</span>
                      <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#0f172a' }}>{step.title}</h3>
                    </div>
                    <p style={{ margin: '0 0 12px', fontSize: 13, color: '#64748b', lineHeight: 1.6 }}>{step.desc}</p>
                    <ul style={{ margin: 0, padding: '0 0 0 16px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {step.steps.map((s, j) => (
                        <li key={j} style={{ fontSize: 13, color: '#475569', lineHeight: 1.5 }}>{s}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ══ CONFIGURAÇÕES ══ */}
          {activeNav === 'config' && (
            <div style={{ maxWidth: 560 }}>
              <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e2e8f0', padding: '24px' }}>
                <h3 style={{ margin: '0 0 20px', fontSize: 15, fontWeight: 700, color: '#0f172a' }}>Ambiente de teste</h3>
                <div style={{ marginBottom: 16 }}>
                  <label style={{ fontSize: 13, fontWeight: 500, color: '#374151', display: 'block', marginBottom: 6 }}>URL de teste (staging)</label>
                  <input type="text" placeholder="https://staging.marca-f.exemplo.com.br" value={testUrl} onChange={e => setTestUrl(e.target.value)} style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
                </div>
                <div style={{ marginBottom: 20 }}>
                  <label style={{ fontSize: 13, fontWeight: 500, color: '#374151', display: 'block', marginBottom: 6 }}>URL do GTM Preview</label>
                  <input type="text" placeholder="https://tagassistant.google.com/preview/..." value={gtmPreviewUrl} onChange={e => setGtmPreviewUrl(e.target.value)} style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
                </div>
                {(testUrl || gtmPreviewUrl) && (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderRadius: 8, background: '#fffbeb', border: '1px solid #fde68a' }}>
                    <span style={{ fontSize: 12, color: '#92400e' }}>⚠ Modo de teste ativo</span>
                    <button onClick={() => { setTestUrl(''); setGtmPreviewUrl('') }} style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid #fde68a', background: '#fff', cursor: 'pointer', color: '#92400e' }}>Limpar</button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ══ MARCAS ══ */}
          {activeNav === 'marcas' && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
                <button onClick={openCreateMarca} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 18px', borderRadius: 8, border: 'none', background: ACCENT, color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                  + Nova marca
                </button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16 }}>
                {marcas.map(m => (
                  <div key={m.id} onClick={() => { selecionaMarca(m, null); setActiveNav('dashboard') }} style={{ background: '#fff', borderRadius: 12, border: marcaAtiva?.id === m.id ? `2px solid ${ACCENT}` : '1px solid #e2e8f0', padding: '20px', cursor: 'pointer' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                      <div style={{ width: 40, height: 40, borderRadius: 10, background: ACCENT_LIGHT, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>🏷️</div>
                      <button onClick={e => openEditMarca(e, m)} style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer', color: '#64748b' }}>Editar</button>
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a', marginBottom: 4 }}>{m.name}</div>
                    {marcaAtiva?.id === m.id && <Badge bg={ACCENT_LIGHT} color={ACCENT}>Ativa</Badge>}
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>

        {/* Footer */}
        <footer style={{ padding: '16px 32px', borderTop: '1px solid #e2e8f0', textAlign: 'center', fontSize: 12, color: '#64748b' }}>
          Data Tracking · grupo
        </footer>
      </main>

      {/* ══ MODAL MARCA ══ */}
      {showMarcaModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: '28px', width: 480, maxWidth: '90vw', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
            <h2 style={{ margin: '0 0 20px', fontSize: 17, fontWeight: 700, color: '#0f172a' }}>
              {marcaModalMode === 'create' ? 'Nova marca' : `Editar marca — ${marcaForm.id}`}
            </h2>
            {marcaModalMode === 'create' && (
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 13, fontWeight: 500, color: '#374151', display: 'block', marginBottom: 6 }}>ID da marca</label>
                <input type="text" placeholder="ex: marca-f" value={marcaForm.id} onChange={e => setMarcaForm(f => ({ ...f, id: e.target.value }))} style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
              </div>
            )}
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 13, fontWeight: 500, color: '#374151', display: 'block', marginBottom: 6 }}>Domínio sGTM</label>
              <input type="text" placeholder="ex: sgtm.marca-f.exemplo.com.br" value={marcaForm.sgtm} onChange={e => setMarcaForm(f => ({ ...f, sgtm: e.target.value }))} style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
            </div>
            {marcaMsg && <div style={{ padding: '10px 12px', borderRadius: 8, background: marcaMsg.ok ? '#f0fdf4' : '#fef2f2', color: marcaMsg.ok ? '#15803d' : '#dc2626', fontSize: 13, marginBottom: 14 }}>{marcaMsg.msg}</div>}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowMarcaModal(false)} style={{ padding: '10px 18px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer', fontSize: 13, color: '#64748b' }}>Cancelar</button>
              <button onClick={saveMarca} disabled={savingMarca} style={{ padding: '10px 18px', borderRadius: 8, border: 'none', background: ACCENT, color: '#fff', cursor: savingMarca ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600, opacity: savingMarca ? 0.7 : 1 }}>
                {savingMarca ? 'Salvando...' : marcaModalMode === 'create' ? 'Criar marca' : 'Salvar'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
