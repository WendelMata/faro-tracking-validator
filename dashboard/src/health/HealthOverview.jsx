import { useRef, useState } from 'react'
import './health-theme.css'
import ThemeToggle from './ThemeToggle'
import FullscreenToggle from './FullscreenToggle'
import { isEventoPrincipal, corPorPct, PARAMS_PRINCIPAIS } from './eventos-principais'

function legendaColunas() {
  return [
    { cor: 'var(--wh-accent)', label: 'Disparos', desc: 'Percentual de eventos que dispararam na sessão (independe de parâmetros).' },
    { cor: 'var(--wh-muted)', label: 'Parâmetros', desc: `Cobertura média dos parâmetros do schema. No modo <b>Eventos principais</b>, considera só ${PARAMS_PRINCIPAIS.join(', ')} — sobre os eventos ao lado, não o schema inteiro.` },
    { cor: 'var(--wh-ok)', label: 'Disparos corretos', desc: 'Eventos que dispararam conforme o esperado, sem nenhum parâmetro com problema.' },
    { cor: 'var(--wh-warn)', label: 'Com aviso', desc: 'Eventos que dispararam certo mas têm parâmetro com problema.' },
    { cor: 'var(--wh-muted)', label: 'Ausentes', desc: 'Evento não encontrado na sessão.' },
    { cor: 'var(--wh-muted)', label: 'Total', desc: 'Total de entradas do schema consideradas no cálculo (evento × região).' },
  ]
}

function formatarDataGravacao(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

const LEGENDA_EVENTOS_PRINCIPAIS = [
  { evento: 'session_start', regra: 'Qualquer região (disparado automaticamente pelo GA4)' },
  { evento: 'view_item_list', regra: 'Apenas região PDC' },
  { evento: 'select_item', regra: 'Apenas região PDC' },
  { evento: 'view_item', regra: 'Qualquer região' },
  { evento: 'add_to_cart', regra: 'Apenas regiões PDC e PDP' },
  { evento: 'begin_checkout', regra: 'Região Checkout' },
  { evento: 'purchase', regra: 'Região Checkout' },
]


export default function HealthOverview({ healthOverview, healthOverviewLoading, healthMarcasFiltro, onChangeFiltro, onSelectMarca, onReload }) {
  const [theme, setTheme] = useState(() => localStorage.getItem('webHealthTheme') || 'light')
  const [legendOpen, setLegendOpen] = useState(false)
  const pageRef = useRef(null)

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    localStorage.setItem('webHealthTheme', next)
  }

  if (healthOverviewLoading) {
    return (
      <div className="web-health-page" data-theme={theme} ref={pageRef}>
        <div className="wh-loading">Carregando saúde de todas as marcas...</div>
      </div>
    )
  }

  if (!healthOverview) {
    return (
      <div className="web-health-page" data-theme={theme} ref={pageRef}>
        <div className="wh-empty">
          <div className="wh-empty-title">Dados de saúde não carregados</div>
          <button className="wh-empty-btn" onClick={onReload}>Carregar</button>
        </div>
      </div>
    )
  }

  const { mediaGeral, totalEventos, marcas } = healthOverview
  const validMarcas = marcas.filter(m => !m.semSessao)

  const marcasCalculadas = marcas.map(m => {
    if (m.semSessao) return m
    const params = m.parametros ?? []
    const pctParams = params.length > 0
      ? Math.round(params.reduce((s, p) => s + (p.cobertura ?? 0), 0) / params.length)
      : 0

    if (healthMarcasFiltro === 'principais') {
      const evs = (m.eventos ?? []).filter(isEventoPrincipal)
      const corretos = evs.filter(e => e.status === 'correto').length
      const criticos = evs.filter(e => e.status === 'erro').length
      const ausentes = evs.filter(e => e.status === 'ausente').length
      const comAviso = evs.filter(e => e.status === 'correto' && (e.paramsErrados ?? []).length > 0).length
      const total = evs.length
      const pct = total > 0 ? Math.round((corretos / total) * 100) : 0
      // Parâmetros principais: só os campos-chave (item_name/item_id/item_sku/item_ref/
      // price/value), avaliados sobre os eventos principais — não o schema inteiro.
      const paramsPrincipais = (m.parametrosPrincipais ?? []).filter(p => PARAMS_PRINCIPAIS.includes(p.name))
      const pctParamsPrincipais = paramsPrincipais.length > 0
        ? Math.round(paramsPrincipais.reduce((s, p) => s + (p.cobertura ?? 0), 0) / paramsPrincipais.length)
        : 0
      return { ...m, pct, pctParams: pctParamsPrincipais, adequados: corretos, criticos, ausentes, comAviso, total }
    }

    // modo 'todos' (default): "comAviso" (evento correto mas com parâmetro com problema)
    // é subconjunto de "correto" na resposta do backend — reparticiona pra "Disparos
    // corretos" (adequados) excluir esses casos, e "Com aviso" ficar com um número
    // próprio (m.criticos aqui é sempre 0, já que o backend calcula em modo 'disparos').
    const evs = (m.eventos ?? []).filter(e => e.evento !== 'session_start')
    const comAviso = evs.filter(e => e.status === 'correto' && (e.paramsErrados ?? []).length > 0).length
    const adequados = Math.max((m.adequados ?? 0) - comAviso, 0)
    return { ...m, pct: m.pct, pctParams, adequados, comAviso }
  })

  const comSessao = marcasCalculadas.filter(m => !m.semSessao)
  const semSessaoCount = marcasCalculadas.length - comSessao.length
  const okCount = comSessao.filter(m => m.pct >= 90).length
  const warnCount = comSessao.filter(m => m.pct >= 70 && m.pct < 90).length
  const errCount = comSessao.filter(m => m.pct < 70).length
  const totalStatus = marcasCalculadas.length || 1

  const faixasStatus = [
    { label: 'Saudável (≥90%)', color: 'var(--wh-ok)', count: okCount },
    { label: 'Atenção (70-89%)', color: 'var(--wh-warn)', count: warnCount },
    { label: 'Crítico (<70%)', color: 'var(--wh-error)', count: errCount },
    ...(semSessaoCount > 0 ? [{ label: 'Sem sessão', color: 'var(--wh-muted)', count: semSessaoCount }] : []),
  ]

  const sorted = [...marcasCalculadas].sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1))

  return (
    <div className="web-health-page" data-theme={theme} ref={pageRef}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 className="wh-detail-title" style={{ marginBottom: 0 }}>Saúde dos Sites</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <FullscreenToggle targetRef={pageRef} />
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </div>

      <div className="wh-kpis">
        <div className="wh-kpi-card">
          <div className="wh-kpi-label">Saúde geral (média)</div>
          <div className="wh-kpi-value" style={{ color: corPorPct(mediaGeral) }}>{mediaGeral}%</div>
          <div className="wh-kpi-sub">{validMarcas.length} marcas com sessão de saúde</div>
        </div>
        <div className="wh-kpi-card">
          <div className="wh-kpi-label">Marcas monitoradas</div>
          <div className="wh-kpi-value">{marcas.length}</div>
          <div className="wh-kpi-sub">{validMarcas.length} configuradas</div>
        </div>
        <div className="wh-kpi-card">
          <div className="wh-kpi-label">Eventos do schema</div>
          <div className="wh-kpi-value">{totalEventos}</div>
          <div className="wh-kpi-sub">Total avaliado</div>
        </div>
      </div>

      <div className="wh-toolbar">
        <details className="wh-legend" open={legendOpen} onToggle={e => setLegendOpen(e.target.open)}>
          <summary>Legenda e eventos principais</summary>
          <div className="wh-legend-body">
            <div>
              <div className="wh-legend-title">Significado das colunas</div>
              {legendaColunas().map(({ cor, label, desc }) => (
                <div className="wh-legend-row" key={label}>
                  <span className="k" style={{ color: cor }}>{label}</span>
                  <span className="v" dangerouslySetInnerHTML={{ __html: desc }} />
                </div>
              ))}
            </div>
            <div>
              <div className="wh-legend-title">Eventos principais e regras de região</div>
              {LEGENDA_EVENTOS_PRINCIPAIS.map(({ evento, regra }) => (
                <div className="wh-legend-row" key={evento}>
                  <code>{evento}</code>
                  <span className="v">{regra}</span>
                </div>
              ))}
            </div>
          </div>
        </details>

        <div className="wh-calc-row">
          <label htmlFor="wh-calc-mode">Calcular saúde com:</label>
          <select id="wh-calc-mode" className="wh-calc-select" value={healthMarcasFiltro} onChange={e => onChangeFiltro(e.target.value)}>
            <option value="todos">Todos eventos</option>
            <option value="principais">Eventos principais</option>
          </select>
        </div>
      </div>

      <div className="wh-grid">
        <div className="wh-panel">
          <div className="wh-panel-title">Detalhamento por marca</div>
          <div className="wh-panel-pad">
            <div style={{ fontSize: 12, color: 'var(--wh-muted)', margin: '4px 0 10px' }}>
              Calculado com <strong>{{ todos: 'Todos eventos', principais: 'Eventos principais' }[healthMarcasFiltro]}</strong>
            </div>
            <div className="wh-table-wrap">
              <table className="wh-table wh-table--clickable-rows">
                <thead>
                  <tr>
                    <th scope="col">Marca</th>
                    <th scope="col">Disparos</th>
                    <th scope="col">Parâmetros</th>
                    <th scope="col">Disparos corretos</th>
                    <th
                      scope="col"
                      className="wh-tooltip"
                      tabIndex={0}
                      aria-describedby="wh-th-aviso-desc"
                      data-tooltip="Eventos que dispararam certo mas têm parâmetro com problema"
                    >
                      Com aviso
                      <span id="wh-th-aviso-desc" className="wh-sr-only">Eventos que dispararam certo mas têm parâmetro com problema</span>
                    </th>
                    <th
                      scope="col"
                      className="wh-tooltip"
                      tabIndex={0}
                      aria-describedby="wh-th-ausentes-desc"
                      data-tooltip="Evento não encontrado na sessão"
                    >
                      Ausentes
                      <span id="wh-th-ausentes-desc" className="wh-sr-only">Evento não encontrado na sessão</span>
                    </th>
                    <th scope="col">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.length === 0 ? (
                    <tr><td colSpan={7} style={{ padding: 40, color: 'var(--wh-muted)' }}>Nenhuma marca encontrada</td></tr>
                  ) : sorted.map((m) => {
                    if (m.semSessao) {
                      return (
                        <tr key={m.marca}>
                          <td><span className="wh-dot" style={{ background: 'var(--wh-decoration)' }} />{m.marca}</td>
                          <td colSpan={6} style={{ color: 'var(--wh-muted)', fontStyle: 'italic', fontSize: 12 }}>Sem sessão de saúde definida</td>
                        </tr>
                      )
                    }
                    const cor = corPorPct(m.pct)
                    const pctP = m.pctParams ?? 0
                    const corP = corPorPct(pctP)
                    const comAviso = m.comAviso ?? 0
                    return (
                      <tr
                        key={m.marca}
                        onClick={() => onSelectMarca(m.marca)}
                        tabIndex={0}
                        role="button"
                        aria-label={`Ver detalhes de saúde de ${m.marca}`}
                        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectMarca(m.marca) } }}
                      >
                        <td>
                          <span className="wh-dot" style={{ background: cor }} />{m.marca}
                          {formatarDataGravacao(m.dataGravacao) && (
                            <span style={{ color: 'var(--wh-muted)', fontSize: 11, fontWeight: 400, marginLeft: 6 }}>{formatarDataGravacao(m.dataGravacao)}</span>
                          )}
                        </td>
                        <td style={{ color: cor, fontWeight: 700 }}>{m.pct}%</td>
                        <td style={{ color: corP, fontWeight: 700 }}>{pctP}%</td>
                        <td style={{ color: 'var(--wh-ok)', fontWeight: 600 }}>{m.adequados} ({m.total > 0 ? Math.round(m.adequados / m.total * 100) : 0}%)</td>
                        <td style={{ color: 'var(--wh-warn)', fontWeight: 600 }}>
                          {comAviso} ({m.total > 0 ? Math.round(comAviso / m.total * 100) : 0}%)
                        </td>
                        <td style={{ color: 'var(--wh-warn)', fontWeight: 600 }}>{m.ausentes} ({m.total > 0 ? Math.round(m.ausentes / m.total * 100) : 0}%)</td>
                        <td style={{ color: 'var(--wh-muted)' }}>{m.total}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="wh-panel">
          <div className="wh-panel-title">Marcas por status</div>
          <div className="wh-panel-pad">
            {faixasStatus.map(f => (
              <div className="wh-status-row" key={f.label}>
                <span className="wh-status-label"><span className="wh-dot" style={{ background: f.color }} />{f.label}</span>
                <span className="wh-status-count" style={{ color: f.color }}>{f.count}</span>
              </div>
            ))}
            <div className="wh-status-bar">
              {faixasStatus.filter(f => f.count > 0).map(f => (
                <div key={f.label} style={{ width: `${totalStatus > 0 ? (f.count / totalStatus) * 100 : 0}%`, background: f.color }} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
