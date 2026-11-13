// Servidor de contas do Jogo da Transformação (Node 22+, sem dependências).
//
// O que ele NÃO sabe: o CPF (chega só um hash feito no jogo, que aqui ainda passa por um HMAC com
// segredo do servidor), o PIN (chega um verificador derivado dele, que aqui é guardado com scrypt) e
// os dados do jogo (chegam cifrados com uma chave que só existe no aparelho do jogador).
//
// Uma conta, um lugar por vez: entrar gera uma sessão nova e derruba a anterior (o jogo antigo
// recebe 401 "outro_lugar" no próximo pulso e fecha com aviso).
//
// Uso: node servidor/servidor.mjs   (porta pela variável PORTA, padrão 8787)
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PASTA = process.env.DADOS || path.join(path.dirname(fileURLToPath(import.meta.url)), 'dados');
const ARQ_CONTAS = path.join(PASTA, 'contas.json');
const ARQ_SEGREDO = path.join(PASTA, 'segredo.txt');
const PORTA = Number(process.env.PORTA || 8787);
const MAX_SAVE = 8 * 1024 * 1024;          // 8 MB de save cifrado
const ERROS_ATE_BLOQUEAR = 5;
const BLOQUEIO_MIN = 15;

fs.mkdirSync(PASTA, { recursive: true });
if (!fs.existsSync(ARQ_SEGREDO)) fs.writeFileSync(ARQ_SEGREDO, crypto.randomBytes(32).toString('hex'));
const SEGREDO = process.env.SEGREDO || fs.readFileSync(ARQ_SEGREDO, 'utf8').trim();

let contas = fs.existsSync(ARQ_CONTAS) ? JSON.parse(fs.readFileSync(ARQ_CONTAS, 'utf8')) : {};
function gravar() {
  const tmp = ARQ_CONTAS + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(contas));
  fs.renameSync(tmp, ARQ_CONTAS);
}

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

// tentativas erradas por IP (além do bloqueio por conta)
const porIp = new Map();
function ipBloqueado(ip) {
  const r = porIp.get(ip);
  if (!r) return false;
  if (Date.now() - r.desde > 3600_000) { porIp.delete(ip); return false; }
  return r.n >= 30;
}
function errouIp(ip) {
  const r = porIp.get(ip) || { n: 0, desde: Date.now() };
  r.n++; porIp.set(ip, r);
}

// consultas e cadastros por IP (contra varrer CPFs e criar contas em massa)
const consultas = new Map();
function excedeu(ip, tipo, max) {
  const k = tipo + '|' + ip;
  const r = consultas.get(k);
  if (!r || Date.now() - r.desde > 3600_000) { consultas.set(k, { n: 1, desde: Date.now() }); return false; }
  r.n++;
  return r.n > max;
}

function sessaoDe(corpo) {
  if (!valido(corpo.token)) return null;
  const h = hashToken(corpo.token);
  for (const [id, c] of Object.entries(contas)) if (c.sessao === h) return [id, c];
  return null;
}

const rotas = {
  // a conta existe? (o jogo decide se pede "digite o PIN" ou "crie um PIN")
  '/conta/existe': (b, ip) => {
    if (!valido(b.conta)) return [400, { erro: 'conta' }];
    if (excedeu(ip, 'existe', 60)) return [429, { erro: 'muitas_tentativas', minutos: 60 }];
    return [200, { existe: !!contas[idDa(b.conta)] }];
  },

  '/conta/registrar': (b, ip) => {
    if (!valido(b.conta) || !valido(b.verificador)) return [400, { erro: 'dados' }];
    if (excedeu(ip, 'registrar', 5)) return [429, { erro: 'muitas_tentativas', minutos: 60 }];
    const id = idDa(b.conta);
    if (contas[id]) return [409, { erro: 'ja_existe' }];
    const sal = crypto.randomBytes(16);
    contas[id] = { sal: sal.toString('hex'), verif: crypto.scryptSync(b.verificador, sal, 32).toString('hex'),
      criada: Date.now(), save: null, versao: 0, erros: 0, bloqueada_ate: 0 };
    const token = novaSessao(contas[id]);
    gravar();
    return [200, { token, nova: true }];
  },

  '/conta/entrar': (b, ip) => {
    if (!valido(b.conta) || !valido(b.verificador)) return [400, { erro: 'dados' }];
    if (ipBloqueado(ip)) return [429, { erro: 'muitas_tentativas', minutos: 60 }];
    const c = contas[idDa(b.conta)];
    if (!c) return [404, { erro: 'nao_existe' }];
    if (c.bloqueada_ate > Date.now()) return [429, { erro: 'muitas_tentativas', minutos: Math.ceil((c.bloqueada_ate - Date.now()) / 60000) }];
    if (!verificar(c, b.verificador)) {
      errouIp(ip);
      c.erros++;
      if (c.erros >= ERROS_ATE_BLOQUEAR) { c.bloqueada_ate = Date.now() + BLOQUEIO_MIN * 60000 * (c.erros - ERROS_ATE_BLOQUEAR + 1); }
      gravar();
      return [401, { erro: 'pin', restam: Math.max(0, ERROS_ATE_BLOQUEAR - c.erros) }];
    }
    c.erros = 0; c.bloqueada_ate = 0;
    const derrubou = !!c.sessao;
    const token = novaSessao(c);   // a sessão anterior (outro aparelho) deixa de valer
    gravar();
    return [200, { token, save: c.save, versao: c.versao, derrubou }];
  },

  // pulso: a sessão ainda é minha?
  '/sessao': (b) => (sessaoDe(b) ? [200, { ok: true }] : [401, { erro: 'outro_lugar' }]),

  '/save': (b) => {
    const s = sessaoDe(b);
    if (!s) return [401, { erro: 'outro_lugar' }];
    if (typeof b.save !== 'string' || b.save.length > MAX_SAVE) return [400, { erro: 'save' }];
    s[1].save = b.save;
    s[1].versao = (s[1].versao || 0) + 1;
    s[1].salvo_em = Date.now();
    gravar();
    return [200, { versao: s[1].versao }];
  },

  '/sair': (b) => {
    const s = sessaoDe(b);
    if (s) { s[1].sessao = null; gravar(); }
    return [200, { ok: true }];
  },
};

http.createServer((req, res) => {
  const responder = (cod, obj) => {
    res.writeHead(cod, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  const rota = rotas[req.url];
  if (req.method !== 'POST' || !rota) return responder(404, { erro: 'rota' });
  let tam = 0;
  const partes = [];
  req.on('data', (p) => {
    tam += p.length;
    if (tam > MAX_SAVE + 4096) { responder(413, { erro: 'grande' }); req.destroy(); }
    else partes.push(p);
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    let corpo;
    try { corpo = JSON.parse(Buffer.concat(partes).toString('utf8') || '{}'); } catch { return responder(400, { erro: 'json' }); }
    try {
      const [cod, obj] = rota(corpo, req.socket.remoteAddress);
      responder(cod, obj);
    } catch (e) {
      console.error(e);
      responder(500, { erro: 'interno' });
    }
  });
}).listen(PORTA, () => console.log(`servidor de contas na porta ${PORTA}`));
