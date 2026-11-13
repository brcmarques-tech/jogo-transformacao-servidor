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
// Variáveis: PORT/PORTA, DATABASE_URL, SEGREDO (HMAC do CPF), ADMIN (publicar versão), DADOS (pasta local).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORTA = Number(process.env.PORT || process.env.PORTA || 8787);
const MAX_SAVE = 8 * 1024 * 1024;           // 8 MB de save cifrado
const MAX_PCK = 200 * 1024 * 1024;          // pacote do jogo
const ERROS_ATE_BLOQUEAR = 5;
const BLOQUEIO_MIN = 15;

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
      for (const [id, c] of Object.entries(contas)) if (c.sessao === h) return [id, c];
      return null;
    },
    async versao() { return fs.existsSync(ARQ_V) ? JSON.parse(fs.readFileSync(ARQ_V, 'utf8')) : null; },
    async pck() { const p = path.join(PASTA, 'jogo.pck'); return fs.existsSync(p) ? fs.readFileSync(p) : null; },
    async publicar(versao, sha256, buf) {
      fs.writeFileSync(path.join(PASTA, 'jogo.pck'), buf);
      fs.writeFileSync(ARQ_V, JSON.stringify({ versao, sha256, tamanho: buf.length, publicado: new Date() }));
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
    return [200, { token, nova: true }];
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
    return [200, { token, save: c.save, versao: c.versao, derrubou }];
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

  '/sair': async (b) => {
    const s = await sessaoDe(b);
    if (s) { const c = s[1]; c.sessao = null; await banco.gravarDados(s[0], c); }
    return [200, { ok: true }];
  },
};

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
  try {
    const url = req.url.split('?')[0];
    // ---- atualização do jogo (público)
    if (req.method === 'GET' && url === '/atualizacao') {
      const v = await banco.versao();
      return responder(res, 200, v ? { versao: v.versao, sha256: v.sha256, tamanho: v.tamanho } : { versao: '' });
    }
    if (req.method === 'GET' && url === '/atualizacao/jogo.pck') {
      const pck = await banco.pck();
      if (!pck) return responder(res, 404, { erro: 'sem_versao' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': pck.length });
      return res.end(pck);
    }
    if (req.method === 'GET' && (url === '/' || url === '/saude')) {
      return responder(res, 200, { ok: true, jogo: 'Jogo da Transformação' });
    }
    // ---- publicar versão nova (só com o segredo ADMIN)
    if (req.method === 'POST' && url === '/admin/atualizacao') {
      const admin = process.env.ADMIN || '';
      const veio = String(req.headers['x-admin'] || '');
      if (!admin || veio.length !== admin.length || !crypto.timingSafeEqual(Buffer.from(veio), Buffer.from(admin))) {
        return responder(res, 403, { erro: 'admin' });
      }
      const versao = String(req.headers['x-versao'] || '');
      if (!/^[0-9]+(\.[0-9]+)*$/.test(versao)) return responder(res, 400, { erro: 'versao' });
      const buf = await lerCorpo(req, MAX_PCK);
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      await banco.publicar(versao, sha256, buf);
      return responder(res, 200, { versao, sha256, tamanho: buf.length });
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
}).listen(PORTA, () => console.log(`servidor do jogo na porta ${PORTA} (${process.env.DATABASE_URL ? 'Postgres' : 'arquivos'})`));

// Render grátis dorme sem acesso. Com MANTER_ACORDADO=1 o próprio servidor se chama a cada 10 min
// (gasta as 750 h grátis do workspace inteiro; por padrão fica desligado: os dados estão no Postgres,
// dormir só deixa o primeiro login mais lento).
if (process.env.RENDER_EXTERNAL_URL && process.env.MANTER_ACORDADO === "1") {
  setInterval(() => { fetch(process.env.RENDER_EXTERNAL_URL + '/saude').catch(() => {}); }, 10 * 60 * 1000);
}
