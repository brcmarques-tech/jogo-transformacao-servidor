// Servidor de contas e de atualização do Jogo da Transformação (Node 22+).
//
// O que ele NÃO sabe: o CPF (chega só um hash feito no jogo, que aqui ainda passa por um HMAC com
// segredo do servidor), o PIN (chega um verificador derivado dele, guardado com scrypt) e os dados
// do jogo (chegam cifrados com uma chave que só existe no aparelho do jogador).
//
// Uma conta, um lugar por vez: entrar gera uma sessão nova e derruba a anterior (o jogo antigo
// recebe 401 "outro_lugar" no próximo pulso e fecha com aviso).
//
// Atualização: o jogo pergunta GET /atualizacao e baixa GET /atualizacao/jogo.pck quando há versão
// nova. Publicar uma versão: POST /admin/atualizacao com o cabeçalho "x-admin" (segredo ADMIN).
//
// Guarda: Postgres (DATABASE_URL, ex.: Neon) — ou, sem ela, arquivos em servidor/dados (teste local).
// Variáveis: PORT/PORTA, DATABASE_URL, SEGREDO (HMAC do CPF), ADMIN (publicar versão), DADOS (pasta local),
// GEMINI_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY (IA do diário: tenta nessa ordem), IA_POR_DIA (limite por conta).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { montarCidade } from './cidade.mjs';

const PORTA = Number(process.env.PORT || process.env.PORTA || 8787);
const MAX_SAVE = 8 * 1024 * 1024;           // 8 MB de save cifrado
const MAX_PCK = 200 * 1024 * 1024;          // pacote do jogo
const ERROS_ATE_BLOQUEAR = 5;
const BLOQUEIO_MIN = 15;
const IA_POR_DIA = Number(process.env.IA_POR_DIA || 8);
const MAX_IA_TEXTO = 80 * 1024;

// ------------------------------------------------------------------ IA (as chaves nunca saem daqui)

async function comTempo(url, opcoes, ms = 45000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opcoes, signal: ctl.signal }); } finally { clearTimeout(t); }
}

const PROVEDORES = [
  ['gemini', async (sistema, texto) => {
    if (!process.env.GEMINI_API_KEY) return null;
    // sem "raciocínio" (thinking): era ele que fazia a análise demorar; o lite é o reserva
    for (const [modelo, extra] of [['gemini-flash-latest', { thinkingConfig: { thinkingBudget: 0 } }], ['gemini-flash-lite-latest', {}]]) {
      const r = await comTempo(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify({ system_instruction: { parts: [{ text: sistema }] }, contents: [{ role: 'user', parts: [{ text: texto }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 1500, ...extra } }) }, 30000);
      if (!r.ok) continue;
      const j = await r.json();
      const cand = j.candidates?.[0];
      const out = (cand?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('').trim();
      if (out && cand?.finishReason !== 'MAX_TOKENS') return out;   // cortada no meio: tenta o próximo
    }
    return null;
  }],
  ['anthropic', async (sistema, texto) => {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    const r = await comTempo('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 1200, system: sistema, messages: [{ role: 'user', content: texto }] }) });
    if (!r.ok) return null;
    const j = await r.json();
    return (j.content || []).map((c) => c.text || '').join('').trim() || null;
  }],
  ['openai', async (sistema, texto) => {
    if (!process.env.OPENAI_API_KEY) return null;
    const r = await comTempo('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
      body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 1200, messages: [{ role: 'system', content: sistema }, { role: 'user', content: texto }] }) });
    if (!r.ok) return null;
    const j = await r.json();
    return j.choices?.[0]?.message?.content?.trim() || null;
  }],
];

async function perguntarIA(sistema, texto) {
  for (const [nome, chamar] of PROVEDORES) {
    try {
      const out = await chamar(sistema, texto);
      if (out) return [nome, out];
    } catch (e) { console.error('ia', nome, e.message); }
  }
  return [null, null];
}

// Voz (Gemini TTS): só lê textos que a própria IA daqui escreveu para aquela conta (não vira TTS grátis).
// Volta PCM 16 bits mono 16 kHz (o Gemini manda 24 kHz; 16 kHz basta para voz e pesa 1/3 a menos).
const VOZ_MODELOS = ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts', 'gemini-2.5-flash-preview-tts'];
const textosDaIA = new Map();   // conta -> [{ h, texto, t, audio }]
const hashTexto = (t) => crypto.createHash('sha256').update(String(t).trim()).digest('hex');
function lembrarTexto(conta, texto) {
  const l = (textosDaIA.get(conta) || []).filter((x) => Date.now() - x.t < 6 * 3600e3).slice(-4);
  l.push({ h: hashTexto(texto), texto, t: Date.now() });
  textosDaIA.set(conta, l);
}

function pcm16k(buf) {
  let dados = buf, taxa = 24000;
  if (buf.slice(0, 4).toString() === 'RIFF') {   // wav: acha o bloco "data"
    taxa = buf.readUInt32LE(24);
    let p = 12;
    while (p + 8 <= buf.length) {
      const id = buf.slice(p, p + 4).toString(), tam = buf.readUInt32LE(p + 4);
      if (id === 'data') { dados = buf.slice(p + 8, p + 8 + tam); break; }
      p += 8 + tam;
    }
  }
  const n = Math.floor(dados.length / 2);
  if (taxa <= 16000 || n < 4) return dados;
  const ent = (i) => dados.readInt16LE(Math.min(n - 1, Math.max(0, i)) * 2);
  const passo = taxa / 16000, m = Math.floor(n / passo), out = Buffer.alloc(m * 2);
  for (let i = 0; i < m; i++) {
    const x = i * passo, a = Math.floor(x), f = x - a;
    const v = (ent(a - 1) + 2 * ent(a) + ent(a + 1)) / 4 * (1 - f) + (ent(a) + 2 * ent(a + 1) + ent(a + 2)) / 4 * f;   // suaviza e interpola
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2);
  }
  return out;
}

async function falarTexto(texto) {
  if (!process.env.GEMINI_API_KEY) return null;
  const limpo = texto.replace(/[*#_•>]/g, ' ').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').slice(0, 2500);
  for (const modelo of VOZ_MODELOS) {
    try {
      const r = await comTempo(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify({ contents: [{ parts: [{ text: limpo }] }],   // só o texto: o modelo lite lia a instrução em voz alta
          generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } } }) }, 60000);
      if (!r.ok) { console.error('voz', modelo, r.status); continue; }
      const j = await r.json();
      const d = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
      if (d?.data) return pcm16k(Buffer.from(d.data, 'base64'));
    } catch (e) { console.error('voz', modelo, e.message); }
  }
  return null;
}

// ------------------------------------------------------------------ guarda (Postgres ou arquivo)

const banco = await (async () => {
  if (process.env.DATABASE_URL) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 4 });
    await pool.query(`create table if not exists contas (
      id text primary key, dados jsonb not null, save text, atualizado timestamptz default now())`);
    await pool.query(`create table if not exists atualizacao (
      id int primary key, versao text not null, sha256 text not null, tamanho int not null,
      pck bytea not null, publicado timestamptz default now())`);
    await pool.query(`create table if not exists config (chave text primary key, valor text not null)`);
    await pool.query(`create table if not exists instalador_partes (n int primary key, dados bytea not null)`);
    await pool.query(`create table if not exists cidades (codigo text primary key, dados jsonb not null, atualizado timestamptz default now())`);
    await pool.query(`create table if not exists arquivos_partes (arquivo text not null, n int not null, dados bytea not null, primary key (arquivo, n))`);
    return {
      async conta(id) {
        const r = await pool.query('select dados, save from contas where id = $1', [id]);
        return r.rows[0] ? { ...r.rows[0].dados, save: r.rows[0].save } : null;
      },
      async gravar(id, c) {
        const { save, ...dados } = c;
        await pool.query(`insert into contas (id, dados, save) values ($1, $2, $3)
          on conflict (id) do update set dados = $2, save = $3, atualizado = now()`, [id, dados, save ?? null]);
      },
      async gravarDados(id, c) {   // sem mexer no save (sessão, erros de PIN)
        const { save, ...dados } = c;
        await pool.query('update contas set dados = $2 where id = $1', [id, dados]);
      },
      async porSessao(h) {
        const r = await pool.query("select id, dados from contas where dados->>'sessao' = $1", [h]);
        return r.rows[0] ? [r.rows[0].id, r.rows[0].dados] : null;
      },
      async contaDoPid(pid) {
        const r = await pool.query("select id, dados from contas where dados->>'pid' = $1", [pid]);
        return r.rows[0] ? [r.rows[0].id, r.rows[0].dados] : null;
      },
      async cidadeLer(codigo) {
        const r = await pool.query('select dados from cidades where codigo = $1', [codigo]);
        return r.rows[0]?.dados || null;
      },
      async cidadeGravar(codigo, dados) {
        await pool.query('insert into cidades (codigo, dados) values ($1, $2) on conflict (codigo) do update set dados = $2, atualizado = now()', [codigo, dados]);
      },
      async cidadeApagar(codigo) { await pool.query('delete from cidades where codigo = $1', [codigo]); },
      async versao() {
        const r = await pool.query('select versao, sha256, tamanho, publicado from atualizacao where id = 1');
        return r.rows[0] || null;
      },
      async pck() {
        const r = await pool.query('select pck from atualizacao where id = 1');
        return r.rows[0]?.pck || null;
      },
      async publicar(versao, sha256, buf) {
        await pool.query(`insert into atualizacao (id, versao, sha256, tamanho, pck) values (1, $1, $2, $3, $4)
          on conflict (id) do update set versao = $1, sha256 = $2, tamanho = $3, pck = $4, publicado = now()`,
          [versao, sha256, buf.length, buf]);
      },
      // o .exe vai em partes de até 8 MB (o servidor grátis tem pouca memória)
      async partes(arquivo) {
        const r = await pool.query('select n, length(dados) t from arquivos_partes where arquivo = $1 order by n', [arquivo]);
        return r.rows.map((x) => ({ n: x.n, t: Number(x.t) }));
      },
      async parte(arquivo, n) {
        const r = await pool.query('select dados from arquivos_partes where arquivo = $1 and n = $2', [arquivo, n]);
        return r.rows[0]?.dados || null;
      },
      async gravarParte(arquivo, n, buf) {
        if (n === 0) await pool.query('delete from arquivos_partes where arquivo = $1', [arquivo]);
        await pool.query('insert into arquivos_partes (arquivo, n, dados) values ($1, $2, $3) on conflict (arquivo, n) do update set dados = $3', [arquivo, n, buf]);
      },
      async config(chave) {
        const r = await pool.query('select valor from config where chave = $1', [chave]);
        return r.rows[0]?.valor ?? null;
      },
      async definirConfig(chave, valor) {
        await pool.query('insert into config (chave, valor) values ($1, $2) on conflict (chave) do update set valor = $2', [chave, valor]);
      },
      async segredo() {
        if (process.env.SEGREDO) return process.env.SEGREDO;
        const r = await pool.query("select valor from config where chave = 'segredo'");
        if (r.rows[0]) return r.rows[0].valor;
        const novo = crypto.randomBytes(32).toString('hex');
        await pool.query("insert into config (chave, valor) values ('segredo', $1) on conflict do nothing", [novo]);
        return (await pool.query("select valor from config where chave = 'segredo'")).rows[0].valor;
      },
    };
  }
  // teste local: arquivos
  const PASTA = process.env.DADOS || path.join(path.dirname(fileURLToPath(import.meta.url)), 'dados');
  fs.mkdirSync(PASTA, { recursive: true });
  const ARQ = path.join(PASTA, 'contas.json');
  const contas = fs.existsSync(ARQ) ? JSON.parse(fs.readFileSync(ARQ, 'utf8')) : {};
  const salvarArq = () => { fs.writeFileSync(ARQ + '.tmp', JSON.stringify(contas)); fs.renameSync(ARQ + '.tmp', ARQ); };
  const ARQ_V = path.join(PASTA, 'atualizacao.json');
  return {
    async conta(id) { return contas[id] ? { ...contas[id] } : null; },
    async gravar(id, c) { contas[id] = { ...c }; salvarArq(); },
    async gravarDados(id, c) { contas[id] = { ...c, save: contas[id]?.save ?? null }; salvarArq(); },
    async porSessao(h) {
      for (const [id, c] of Object.entries(contas)) if (c.sessao === h) return [id, { ...c }];
      return null;
    },
    async contaDoPid(pid) {
      for (const [id, c] of Object.entries(contas)) if (c.pid === pid) return [id, { ...c }];
      return null;
    },
    async cidadeLer(codigo) {
      const a = path.join(PASTA, 'cidades.json');
      return fs.existsSync(a) ? (JSON.parse(fs.readFileSync(a, 'utf8'))[codigo] ?? null) : null;
    },
    async cidadeGravar(codigo, dados) {
      const a = path.join(PASTA, 'cidades.json');
      const c = fs.existsSync(a) ? JSON.parse(fs.readFileSync(a, 'utf8')) : {};
      c[codigo] = dados;
      fs.writeFileSync(a, JSON.stringify(c));
    },
    async cidadeApagar(codigo) {
      const a = path.join(PASTA, 'cidades.json');
      const c = fs.existsSync(a) ? JSON.parse(fs.readFileSync(a, 'utf8')) : {};
      delete c[codigo];
      fs.writeFileSync(a, JSON.stringify(c));
    },
    async versao() { return fs.existsSync(ARQ_V) ? JSON.parse(fs.readFileSync(ARQ_V, 'utf8')) : null; },
    async pck() { const p = path.join(PASTA, 'jogo.pck'); return fs.existsSync(p) ? fs.readFileSync(p) : null; },
    async publicar(versao, sha256, buf) {
      fs.writeFileSync(path.join(PASTA, 'jogo.pck'), buf);
      fs.writeFileSync(ARQ_V, JSON.stringify({ versao, sha256, tamanho: buf.length, publicado: new Date() }));
    },
    async partes(arquivo) {
      const d = path.join(PASTA, 'instalador-' + arquivo);
      if (!fs.existsSync(d)) return [];
      return fs.readdirSync(d).map((x) => ({ n: Number(x), t: fs.statSync(path.join(d, x)).size })).sort((a, b) => a.n - b.n);
    },
    async parte(arquivo, n) { const p = path.join(PASTA, 'instalador-' + arquivo, String(n)); return fs.existsSync(p) ? fs.readFileSync(p) : null; },
    async gravarParte(arquivo, n, buf) {
      const d = path.join(PASTA, 'instalador-' + arquivo);
      if (n === 0) fs.rmSync(d, { recursive: true, force: true });
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, String(n)), buf);
    },
    async config(chave) {
      const a = path.join(PASTA, 'config.json');
      return fs.existsSync(a) ? (JSON.parse(fs.readFileSync(a, 'utf8'))[chave] ?? null) : null;
    },
    async definirConfig(chave, valor) {
      const a = path.join(PASTA, 'config.json');
      const c = fs.existsSync(a) ? JSON.parse(fs.readFileSync(a, 'utf8')) : {};
      c[chave] = valor;
      fs.writeFileSync(a, JSON.stringify(c));
    },
    async segredo() {
      if (process.env.SEGREDO) return process.env.SEGREDO;
      const s = path.join(PASTA, 'segredo.txt');
      if (!fs.existsSync(s)) fs.writeFileSync(s, crypto.randomBytes(32).toString('hex'));
      return fs.readFileSync(s, 'utf8').trim();
    },
  };
})();

const SEGREDO = await banco.segredo();
const idDa = (conta) => crypto.createHmac('sha256', SEGREDO).update(String(conta)).digest('hex');
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const valido = (s, n = 64) => typeof s === 'string' && /^[0-9a-f]+$/.test(s) && s.length === n;

function verificar(c, verificador) {
  const h = crypto.scryptSync(verificador, Buffer.from(c.sal, 'hex'), 32);
  return crypto.timingSafeEqual(h, Buffer.from(c.verif, 'hex'));
}

function novaSessao(c) {
  const token = crypto.randomBytes(32).toString('hex');
  c.sessao = hashToken(token);
  c.sessao_desde = Date.now();
  return token;
}

// limites por IP (contra adivinhar PIN, varrer CPFs e criar contas em massa)
const porIp = new Map();
function conta_ip(ip, tipo) {
  const k = tipo + '|' + ip;
  const r = porIp.get(k);
  if (!r || Date.now() - r.desde > 3600_000) { const novo = { n: 0, desde: Date.now() }; porIp.set(k, novo); return novo; }
  return r;
}
function excedeu(ip, tipo, max) { const r = conta_ip(ip, tipo); r.n++; return r.n > max; }
function ipDe(req) {   // atrás do proxy do Render, o IP real vem no x-forwarded-for
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

async function sessaoDe(corpo) {
  if (!valido(corpo.token)) return null;
  return banco.porSessao(hashToken(corpo.token));
}

const rotas = {
  '/conta/existe': async (b, ip) => {
    if (!valido(b.conta)) return [400, { erro: 'conta' }];
    if (excedeu(ip, 'existe', 60)) return [429, { erro: 'muitas_tentativas', minutos: 60 }];
    return [200, { existe: !!(await banco.conta(idDa(b.conta))) }];
  },

  '/conta/registrar': async (b, ip) => {
    if (!valido(b.conta) || !valido(b.verificador)) return [400, { erro: 'dados' }];
    if (excedeu(ip, 'registrar', 5)) return [429, { erro: 'muitas_tentativas', minutos: 60 }];
    const id = idDa(b.conta);
    if (await banco.conta(id)) return [409, { erro: 'ja_existe' }];
    const sal = crypto.randomBytes(16);
    const c = { sal: sal.toString('hex'), verif: crypto.scryptSync(b.verificador, sal, 32).toString('hex'),
      criada: Date.now(), save: null, versao: 0, erros: 0, bloqueada_ate: 0 };
    const token = novaSessao(c);
    await banco.gravar(id, c);
    return [200, { token, nova: true, geracao: (await banco.config('geracao')) || '' }];
  },

  '/conta/entrar': async (b, ip) => {
    if (!valido(b.conta) || !valido(b.verificador)) return [400, { erro: 'dados' }];
    if (conta_ip(ip, 'pin_errado').n >= 30) return [429, { erro: 'muitas_tentativas', minutos: 60 }];
    const id = idDa(b.conta);
    const c = await banco.conta(id);
    if (!c) return [404, { erro: 'nao_existe' }];
    if (c.bloqueada_ate > Date.now()) return [429, { erro: 'muitas_tentativas', minutos: Math.ceil((c.bloqueada_ate - Date.now()) / 60000) }];
    if (!verificar(c, b.verificador)) {
      conta_ip(ip, 'pin_errado').n++;
      c.erros = (c.erros || 0) + 1;
      if (c.erros >= ERROS_ATE_BLOQUEAR) { c.bloqueada_ate = Date.now() + BLOQUEIO_MIN * 60000 * (c.erros - ERROS_ATE_BLOQUEAR + 1); }
      await banco.gravarDados(id, c);
      return [401, { erro: 'pin', restam: Math.max(0, ERROS_ATE_BLOQUEAR - c.erros) }];
    }
    c.erros = 0; c.bloqueada_ate = 0;
    const derrubou = !!c.sessao;
    const token = novaSessao(c);   // a sessão anterior (outro aparelho) deixa de valer
    await banco.gravarDados(id, c);
    return [200, { token, save: c.save, versao: c.versao, derrubou, geracao: (await banco.config('geracao')) || '' }];
  },

  // pulso: a sessão ainda é minha?
  '/sessao': async (b) => ((await sessaoDe(b)) ? [200, { ok: true }] : [401, { erro: 'outro_lugar' }]),

  '/save': async (b) => {
    const s = await sessaoDe(b);
    if (!s) return [401, { erro: 'outro_lugar' }];
    if (typeof b.save !== 'string' || b.save.length > MAX_SAVE) return [400, { erro: 'save' }];
    const c = await banco.conta(s[0]);
    c.save = b.save;
    c.versao = (c.versao || 0) + 1;
    c.salvo_em = Date.now();
    await banco.gravar(s[0], c);
    return [200, { versao: c.versao }];
  },

  // análise do dia: só logado, limite por conta por dia
  '/ia': async (b, ip) => {
    const s = await sessaoDe(b);
    if (!s) return [401, { erro: 'sessao' }];
    if (typeof b.sistema !== 'string' || typeof b.texto !== 'string' || b.texto.length > MAX_IA_TEXTO || b.sistema.length > 8000) {
      return [400, { erro: 'dados' }];
    }
    if (excedeu(ip, 'ia', IA_POR_DIA * 3)) return [429, { erro: 'limite', por_dia: IA_POR_DIA }];
    const c = s[1];
    const hoje = new Date().toISOString().slice(0, 10);
    if (c.ia_dia !== hoje) { c.ia_dia = hoje; c.ia_n = 0; }
    if (c.ia_n >= IA_POR_DIA) return [429, { erro: 'limite', por_dia: IA_POR_DIA }];
    const [provedor, texto] = await perguntarIA(b.sistema, b.texto);
    if (!texto) return [502, { erro: 'ia_indisponivel' }];
    c.ia_n = (c.ia_n || 0) + 1;
    lembrarTexto(s[0], texto);
    await banco.gravarDados(s[0], c);
    return [200, { texto, provedor, restam: IA_POR_DIA - c.ia_n }];
  },

  '/sair': async (b) => {
    const s = await sessaoDe(b);
    if (s) { const c = s[1]; c.sessao = null; await banco.gravarDados(s[0], c); }
    return [200, { ok: true }];
  },
};

let ultimoUso = Date.now();   // último pedido de verdade (o auto-ping não conta)
const cidade = montarCidade({ banco, sessaoDe, excedeu, marcarUso: () => { ultimoUso = Date.now(); } });
Object.assign(rotas, cidade.rotas);

// "48" < "49", "1.10" > "1.9"
function versaoMenor(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  }
  return false;
}

function responder(res, cod, obj) {
  res.writeHead(cod, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function lerCorpo(req, max) {
  return new Promise((ok, falha) => {
    let tam = 0;
    const partes = [];
    req.on('data', (p) => {
      tam += p.length;
      if (tam > max) { falha(new Error('grande')); req.destroy(); } else partes.push(p);
    });
    req.on('end', () => ok(Buffer.concat(partes)));
    req.on('error', falha);
  });
}

http.createServer(async (req, res) => {
  if (!req.headers['x-auto-ping']) ultimoUso = Date.now();
  try {
    const url = req.url.split('?')[0];
    // ---- atualização do jogo (público)
    if (req.method === 'GET' && url === '/atualizacao') {
      const v = await banco.versao();
      const android = (await banco.config('versao_android')) || '';   // versão do .apk publicado (pode ser mais velha que o pacote)
      // Pacote que precisa de APK novo (ex.: autoload novo): celular com APK mais velho não baixa o pacote,
      // só recebe o aviso do APK. O jogo novo manda ?apk=<versão do APK>; o antigo não manda nada.
      const minimo = (await banco.config('apk_minimo')) || '';
      const ehAndroid = /android/i.test(String(req.headers['user-agent'] || ''));
      const apk = new URL(req.url, 'http://x').searchParams.get('apk') || '0';
      if (v && ehAndroid && minimo && versaoMenor(apk, minimo)) return responder(res, 200, { versao: '', versao_android: android });
      return responder(res, 200, v ? { versao: v.versao, sha256: v.sha256, tamanho: v.tamanho, versao_android: android } : { versao: '', versao_android: android });
    }
    if (req.method === 'GET' && url === '/atualizacao/jogo.pck') {
      const pck = await banco.pck();
      if (!pck) return responder(res, 404, { erro: 'sem_versao' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': pck.length });
      return res.end(pck);
    }
    const ARQUIVOS = {   // o que cada link entrega (baixa uma vez; depois o jogo avisa/atualiza)
      '/baixar': ['windows', 'application/zip', 'Jogo da Transformacao.zip'],
      '/baixar-android': ['android', 'application/vnd.android.package-archive', 'Jogo da Transformacao.apk'],
    };
    if (req.method === 'GET' && ARQUIVOS[url]) {
      const [arquivo, tipo, nome] = ARQUIVOS[url];
      const partes = await banco.partes(arquivo);
      if (!partes.length) return responder(res, 404, { erro: 'sem_instalador' });
      res.writeHead(200, { 'Content-Type': tipo, 'Content-Length': partes.reduce((a, p) => a + p.t, 0),
        'Content-Disposition': 'attachment; filename="' + nome + '"' });
      for (const p of partes) {   // uma parte por vez na memória
        const buf = await banco.parte(arquivo, p.n);
        if (!res.write(buf)) await new Promise((ok) => res.once('drain', ok));
      }
      return res.end();
    }
    if (req.method === 'GET' && (url === '/' || url === '/saude')) {
      return responder(res, 200, { ok: true, jogo: 'Jogo da Transformação' });
    }
    // ---- publicar versão nova (só com o segredo ADMIN)
    const ehAdmin = () => {
      const admin = process.env.ADMIN || '';
      const veio = String(req.headers['x-admin'] || '');
      return admin !== '' && veio.length === admin.length && crypto.timingSafeEqual(Buffer.from(veio), Buffer.from(admin));
    };
    if (req.method === 'POST' && url === '/admin/instalador') {
      if (!ehAdmin()) return responder(res, 403, { erro: 'admin' });
      const n = Number(req.headers['x-parte']);
      const arquivo = String(req.headers['x-arquivo'] || 'windows');
      if (!Number.isInteger(n) || n < 0 || n > 64) return responder(res, 400, { erro: 'parte' });
      if (!['windows', 'android'].includes(arquivo)) return responder(res, 400, { erro: 'arquivo' });
      const buf = await lerCorpo(req, 9 * 1024 * 1024);
      await banco.gravarParte(arquivo, n, buf);
      const versao = String(req.headers['x-versao'] || '');
      if (n === 0 && /^[0-9]+(\.[0-9]+)*$/.test(versao)) await banco.definirConfig('versao_' + arquivo, versao);
      return responder(res, 200, { parte: n, tamanho: buf.length });
    }
    if (req.method === 'POST' && url === '/admin/atualizacao') {
      if (!ehAdmin()) return responder(res, 403, { erro: 'admin' });
      const versao = String(req.headers['x-versao'] || '');
      if (!/^[0-9]+(\.[0-9]+)*$/.test(versao)) return responder(res, 400, { erro: 'versao' });
      const buf = await lerCorpo(req, MAX_PCK);
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      await banco.publicar(versao, sha256, buf);
      const minimo = String(req.headers['x-apk-minimo'] || '');
      if (/^[0-9]+(\.[0-9]+)*$/.test(minimo)) await banco.definirConfig('apk_minimo', minimo);
      return responder(res, 200, { versao, sha256, tamanho: buf.length });
    }
    // ---- voz da análise (binário)
    if (req.method === 'POST' && url === '/ia/voz') {
      let b;
      try { b = JSON.parse((await lerCorpo(req, 16 * 1024)).toString('utf8') || '{}'); } catch { return responder(res, 400, { erro: 'json' }); }
      const s = await sessaoDe(b);
      if (!s) return responder(res, 401, { erro: 'sessao' });
      if (excedeu(ipDe(req), 'voz', IA_POR_DIA * 4)) return responder(res, 429, { erro: 'limite' });
      const achado = (textosDaIA.get(s[0]) || []).find((x) => x.h === String(b.hash || ''));
      if (!achado) return responder(res, 404, { erro: 'texto' });
      if (!achado.audio) achado.audio = await falarTexto(achado.texto);
      if (!achado.audio) return responder(res, 502, { erro: 'voz_indisponivel' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': achado.audio.length, 'x-taxa': '16000' });
      return res.end(achado.audio);
    }
    // ---- contas
    const rota = rotas[url];
    if (req.method !== 'POST' || !rota) return responder(res, 404, { erro: 'rota' });
    let corpo;
    try { corpo = JSON.parse((await lerCorpo(req, MAX_SAVE + 4096)).toString('utf8') || '{}'); }
    catch (e) { return responder(res, e.message === 'grande' ? 413 : 400, { erro: e.message === 'grande' ? 'grande' : 'json' }); }
    const [cod, obj] = await rota(corpo, ipDe(req));
    responder(res, cod, obj);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) responder(res, 500, { erro: 'interno' });
  }
}).on('upgrade', (req, socket, head) => {
  cidade.aoUpgrade(req, socket, head).catch(() => socket.destroy());
}).listen(PORTA, () => console.log(`servidor do jogo na porta ${PORTA} (${process.env.DATABASE_URL ? 'Postgres' : 'arquivos'})`));

// Render grátis dorme depois de 15 min sem acesso. Com MANTER_ACORDADO=1 o próprio servidor se chama a cada 10 min:
//  - SEMPRE dentro do horário HORARIO_ACORDADO (hora de Brasília, "6-24" = das 6h à meia-noite; "0-24" = o dia todo);
//  - fora dele, só se alguém usou nos últimos 45 min (jogo aberto: pulso, posição, chat).
// Conta: as 750 h grátis são do workspace inteiro (a luana-api também usa). 6-24 ≈ 560 h/mês e deixa folga;
// 0-24 = 720-744 h, que estoura com qualquer outro serviço acordado. Primeiro acesso depois de dormir: ~30-60 s.
if (process.env.RENDER_EXTERNAL_URL && process.env.MANTER_ACORDADO === "1") {
  const [de, ate] = String(process.env.HORARIO_ACORDADO || '6-24').split('-').map(Number);
  setInterval(() => {
    const hora = (new Date().getUTCHours() + 21) % 24;   // Brasília = UTC-3
    const noHorario = de <= ate ? hora >= de && hora < ate : hora >= de || hora < ate;
    if (noHorario || Date.now() - ultimoUso < 45 * 60 * 1000) {
      fetch(process.env.RENDER_EXTERNAL_URL + '/saude', { headers: { 'x-auto-ping': '1' } }).catch(() => {});
    }
  }, 10 * 60 * 1000);
}
