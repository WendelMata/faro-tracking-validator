'use strict';

/**
 * Faro Agente — servidor local que gerencia a captura ADB
 * Fica rodando na máquina do usuário e recebe comandos do dashboard.
 * Permite que o botão Iniciar/Parar funcione mesmo com servidor remoto (Cloud Run).
 *
 * Porta: 3001
 * Uso:   node mobile/faro-agente.js
 *        (ou via faro-agente.bat)
 */

const express  = require('express');
const { spawn } = require('child_process');
const path     = require('path');

const app        = express();
const PORT_AGENT = 3001;
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3002';
const ADB_PATH   = process.env.ADB_PATH   || 'C:\\platform-tools\\adb.exe';

app.use(express.json());

// CORS aberto — necessário para dashboard em Cloud Run chamar localhost
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

let captureProcess = null;
let agentState = { status: 'idle', marca: null, device: null, sessionId: null, startedAt: null };

app.get('/status', (req, res) => {
  res.json({ online: true, ...agentState });
});

app.post('/start', (req, res) => {
  if (captureProcess) return res.status(400).json({ error: 'Captura já em andamento' });
  const { marca, device, nome, pasta } = req.body;
  if (!marca || !device) return res.status(400).json({ error: 'marca e device são obrigatórios' });

  const script = path.join(__dirname, 'adb-capture.js');
  const child  = spawn('node', [script, marca, device, nome || '', pasta || ''], {
    env: { ...process.env, SERVER_URL, ADB_PATH },
    cwd: path.join(__dirname, '..'),
  });

  captureProcess = child;
  agentState = { status: 'recording', marca, device, sessionId: null, startedAt: new Date().toISOString() };

  child.stdout.on('data', data => {
    const text = data.toString();
    process.stdout.write(text);
    const m = text.match(/Sessão:\s+(adb-\S+)/);
    if (m) agentState.sessionId = m[1];
  });
  child.stderr.on('data', data => process.stderr.write(data.toString()));
  child.on('close', () => {
    captureProcess = null;
    agentState = { status: 'idle', marca: null, device: null, sessionId: null, startedAt: null };
  });

  res.json({ success: true, marca, device });
});

app.post('/stop', async (req, res) => {
  const sid = agentState.sessionId;
  if (captureProcess) {
    try { captureProcess.kill(); } catch {}
  } else {
    agentState = { status: 'idle', marca: null, device: null, sessionId: null, startedAt: null };
  }
  if (sid) {
    // sessionId conhecido: chama session/stop para salvar sessão com nome, eventos e summary
    try {
      await fetch(`${SERVER_URL}/api/mobile/session/stop/${sid}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Faro-Token': process.env.FARO_API_TOKEN || '' },
        body: '{}',
      });
    } catch {}
  } else {
    // sessionId não disponível: apenas reseta estado do servidor
    try {
      await fetch(`${SERVER_URL}/api/mobile/capture/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Faro-Token': process.env.FARO_API_TOKEN || '' },
        body: '{}',
      });
    } catch {}
  }
  res.json({ success: true, sessionId: sid });
});

function runAdb(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ADB_PATH, args);
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', code => resolve({ stdout: out.trim(), stderr: err.trim(), code }));
    proc.on('error', reject);
  });
}

app.get('/devices', async (req, res) => {
  try {
    const { stdout } = await runAdb(['devices']);
    const lines = stdout.split('\n').slice(1).map(l => l.trim()).filter(Boolean);
    const devices = lines.map(l => {
      const parts  = l.split(/\s+/);
      const serial = parts[0];
      const status = parts[1] || 'unknown';
      const isUsb  = !/^\d/.test(serial) && !serial.startsWith('adb-');
      const isMdns = serial.startsWith('adb-');
      return { serial, status, isUsb, isMdns };
    });
    res.json({ devices });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/devices/tcpip', async (req, res) => {
  const { serial } = req.body || {};
  if (!serial) return res.status(400).json({ error: 'serial é obrigatório' });
  try {
    const { stdout, stderr } = await runAdb(['-s', serial, 'tcpip', '5555']);
    res.json({ success: true, message: stdout || stderr });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/devices/connect', async (req, res) => {
  const { address } = req.body || {};
  if (!address) return res.status(400).json({ error: 'address é obrigatório' });
  try {
    const { stdout } = await runAdb(['connect', address]);
    if (/failed|error|unable/i.test(stdout)) return res.status(400).json({ error: stdout });
    res.json({ success: true, message: stdout });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/devices/disconnect', async (req, res) => {
  const { serial } = req.body || {};
  if (!serial) return res.status(400).json({ error: 'serial é obrigatório' });
  try {
    const { stdout } = await runAdb(['disconnect', serial]);
    res.json({ success: true, message: stdout });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT_AGENT, () => {
  console.log('\n  ====================================');
  console.log('     Faro Agente - Ativo');
  console.log('  ====================================');
  console.log(`  Porta:    ${PORT_AGENT}`);
  console.log(`  Servidor: ${SERVER_URL}`);
  console.log('\n  Mantenha esta janela aberta.');
  console.log('  O botao Iniciar Captura do dashboard usa este agente.\n');
});
