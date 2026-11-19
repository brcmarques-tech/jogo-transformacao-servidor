// Cidade online do Jogo da Transformação.
//
// Cada conta mora numa cidade (código de 6 letras). Uma cidade tem 3 casas. Quem tem o código entra na
// cidade e ganha uma casa livre. Casal mora junto na casa de quem pediu: a casa do outro fica livre.
// Terminar: quem tinha se mudado volta para a casa dele (ou outra livre; sem casa livre, ganha cidade nova).
//
// O servidor guarda da cidade só o que os vizinhos veem: nome curto, "perfil" (aparência, corpo visual,
// casa e a agenda reduzida a horário → atividade, montado pelo jogo) e o chat. Nada do save cifrado.
// Tempo real por WebSocket (/ao-vivo?t=TOKEN): posição de quem está com o jogo aberto e o chat.
// Quem está com o jogo fechado aparece pela agenda (o jogo de quem olha calcula pelo perfil).
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const LETRAS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // sem 0/O e 1/I
const CASAS = [1, 2, 3];
const MAX_PERFIL = 24 * 1024;
const MAX_CHAT = 40;
const MAX_TEXTO_CHAT = 200;

export function montarCidade({ banco, sessaoDe, excedeu }) {
  const cache = new Map();     // codigo -> cidade
  const travas = new Map();    // codigo -> Promise (uma alteração por vez em cada cidade)
  const salas = new Map();     // codigo -> Set(ws)
  const aoVivo = new Map();    // pid -> { ws, pos }
  const gravarDepois = new Map();

  const novoPid = () => crypto.randomBytes(6).toString('hex');

  async function ler(codigo) {
    if (!codigo) return null;
    if (cache.has(codigo)) return cache.get(codigo);
    const d = await banco.cidadeLer(codigo);
    if (d) cache.set(codigo, d);
    return d;
  }

  async function gravar(cid) {
    cache.set(cid.codigo, cid);
    clearTimeout(gravarDepois.get(cid.codigo));
    gravarDepois.delete(cid.codigo);
    await banco.cidadeGravar(cid.codigo, cid);
  }

  function gravarLogo(cid) {   // chat: junta várias mensagens numa gravação
    if (gravarDepois.has(cid.codigo)) return;
    gravarDepois.set(cid.codigo, setTimeout(() => { gravarDepois.delete(cid.codigo); banco.cidadeGravar(cid.codigo, cid).catch((e) => console.error('cidade', e.message)); }, 3000));
  }

  function comTrava(codigo, fn) {
    const antes = travas.get(codigo) || Promise.resolve();
    const agora = antes.then(fn, fn);
    travas.set(codigo, agora.catch(() => {}));
    return agora;
  }

  async function novoCodigo() {
    for (;;) {
      const b = crypto.randomBytes(6);
      const cod = [...b].map((x) => LETRAS[x % LETRAS.length]).join('');
      if (!(await ler(cod))) return cod;
    }
  }

  async function criarCidade(pid, morador) {
    const cid = { codigo: await novoCodigo(), criada: Date.now(), moradores: {}, chat: [] };
    cid.moradores[pid] = { ...morador, casa: 1, casa_propria: 1, parceiro: null, pedidos: [] };
    await gravar(cid);
    return cid;
  }

  const livres = (cid) => CASAS.filter((n) => !Object.values(cid.moradores).some((m) => m.casa === n));

  // garante que a conta tem pid e mora numa cidade (cria uma só dela na primeira vez)
  async function garantir(id, c) {
    let mudou = false;
    if (!c.pid) { c.pid = novoPid(); mudou = true; }
    let cid = await ler(c.cidade);
    if (!cid || !cid.moradores[c.pid]) {
      cid = await criarCidade(c.pid, { nome: '', perfil: null, desde: Date.now() });
      c.cidade = cid.codigo;
      mudou = true;
    }
    if (mudou) await banco.gravarDados(id, c);
    return cid;
  }

  function vista(cid, eu) {
    const moradores = Object.entries(cid.moradores).map(([pid, m]) => ({
      pid, casa: m.casa, nome: m.nome || '', perfil: m.perfil || null, parceiro: m.parceiro || null,
      online: aoVivo.has(pid), pos: aoVivo.get(pid)?.pos || null }));
    return { codigo: cid.codigo, eu, casas: CASAS, livres: livres(cid), moradores,
      pedidos: cid.moradores[eu]?.pedidos || [], chat: cid.chat.slice(-30) };
  }

  function enviar(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }

  function espalhar(codigo, obj, menos = null) {
    const txt = JSON.stringify(obj);
    for (const ws of salas.get(codigo) || []) if (ws !== menos && ws.readyState === 1) ws.send(txt);
  }

  // mudança na cidade (alguém entrou/saiu/casou): cada um recebe a cidade inteira de novo
  function avisarCidade(cid) {
    for (const ws of salas.get(cid.codigo) || []) enviar(ws, { t: 'cidade', ...vista(cid, ws.pid) });
  }

  function mudarDeSala(ws, codigo) {
    if (ws.sala) salas.get(ws.sala)?.delete(ws);
    ws.sala = codigo;
    if (!salas.has(codigo)) salas.set(codigo, new Set());
    salas.get(codigo).add(ws);
  }

  // tira o morador da cidade; cidade vazia some
  async function tirar(cid, pid) {
    delete cid.moradores[pid];
    for (const m of Object.values(cid.moradores)) m.pedidos = (m.pedidos || []).filter((p) => p !== pid);
    espalhar(cid.codigo, { t: 'saiu', pid });
    if (!Object.keys(cid.moradores).length) {
      cache.delete(cid.codigo);
      await banco.cidadeApagar(cid.codigo);
    } else {
      await gravar(cid);
      avisarCidade(cid);
    }
  }

  async function sessao(b) {
    const s = await sessaoDe(b);
    if (!s) return null;
    const cid = await garantir(s[0], s[1]);
    return { id: s[0], c: s[1], pid: s[1].pid, cid };
  }

  const rotas = {
    // a minha cidade (cria na primeira vez)
    '/cidade': async (b) => {
      const s = await sessao(b);
      if (!s) return [401, { erro: 'sessao' }];
      return [200, vista(s.cid, s.pid)];
    },

    // o que os vizinhos veem de mim (o jogo manda ao abrir e quando muda)
    '/cidade/perfil': async (b) => {
      const s = await sessao(b);
      if (!s) return [401, { erro: 'sessao' }];
      const perfil = b.perfil && typeof b.perfil === 'object' ? b.perfil : null;
      if (!perfil || JSON.stringify(perfil).length > MAX_PERFIL) return [400, { erro: 'perfil' }];
      const nome = String(b.nome || '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 16);
      return comTrava(s.cid.codigo, async () => {
        const cid = await ler(s.c.cidade);
        const m = cid?.moradores[s.pid];
        if (!m) return [409, { erro: 'cidade' }];
        m.perfil = perfil;
        m.nome = nome;
        await gravar(cid);
        espalhar(cid.codigo, { t: 'perfil', pid: s.pid, nome, perfil });
        return [200, { ok: true }];
      });
    },

    // entrar em outra cidade pelo código
    '/cidade/entrar': async (b, ip) => {
      const s = await sessao(b);
      if (!s) return [401, { erro: 'sessao' }];
      if (excedeu(ip, 'cidade', 30)) return [429, { erro: 'muitas_tentativas' }];
      const codigo = String(b.codigo || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (codigo === s.cid.codigo) return [200, vista(s.cid, s.pid)];
      const destino = await ler(codigo);
      if (!destino) return [404, { erro: 'nao_existe' }];
      const eu = s.cid.moradores[s.pid];
      if (eu.parceiro) return [409, { erro: 'casal' }];   // casal muda junto? não: termina antes
      const r = await comTrava(codigo, async () => {
        const d = await ler(codigo);
        const casa = livres(d)[0];
        if (!casa) return [409, { erro: 'cheia' }];
        d.moradores[s.pid] = { nome: eu.nome, perfil: eu.perfil, desde: Date.now(), casa, casa_propria: casa, parceiro: null, pedidos: [] };
        await gravar(d);
        s.c.cidade = codigo;
        await banco.gravarDados(s.id, s.c);
        const ws = aoVivo.get(s.pid)?.ws;
        if (ws) { mudarDeSala(ws, codigo); aoVivo.get(s.pid).pos = null; }
        return [200, null];
      });
      if (r[0] !== 200) return r;
      // sai da cidade antiga (fora da trava da nova: nunca segura duas travas ao mesmo tempo)
      await comTrava(s.cid.codigo, async () => { const velha = await ler(s.cid.codigo); if (velha) await tirar(velha, s.pid); });
      const d = await ler(codigo);
      avisarCidade(d);
      return [200, vista(d, s.pid)];
    },

    // relacionamento: pedir, aceitar, recusar, terminar
    '/cidade/relacao': async (b) => {
      const s = await sessao(b);
      if (!s) return [401, { erro: 'sessao' }];
      const acao = String(b.acao || '');
      const outro = String(b.pid || '');
      return comTrava(s.cid.codigo, async () => {
        const cid = await ler(s.c.cidade);
        const eu = cid.moradores[s.pid];
        const ele = cid.moradores[outro];
        if (acao === 'terminar') {
          const p = cid.moradores[eu.parceiro];
          if (!p) { eu.parceiro = null; await gravar(cid); return [200, vista(cid, s.pid)]; }
          eu.parceiro = null;
          p.parceiro = null;
          // quem tinha se mudado volta para a própria casa (ou outra livre)
          const mudou = [eu, p].find((m) => m.casa !== m.casa_propria);
          let sobrou = null;
          if (mudou) {
            const l = livres(cid);
            const volta = l.includes(mudou.casa_propria) ? mudou.casa_propria : l[0];
            if (volta) { mudou.casa = volta; mudou.casa_propria = volta; } else sobrou = mudou;
          }
          if (sobrou) {   // cidade cheia: ganha uma cidade nova só dele
            const pid = Object.keys(cid.moradores).find((k) => cid.moradores[k] === sobrou);
            const nova = await criarCidade(pid, { nome: sobrou.nome, perfil: sobrou.perfil, desde: Date.now() });
            const conta = pid === s.pid ? [s.id, s.c] : await banco.contaDoPid(pid);
            if (conta) { conta[1].cidade = nova.codigo; await banco.gravarDados(conta[0], conta[1]); }
            delete cid.moradores[pid];
            const ws = aoVivo.get(pid)?.ws;
            if (ws) { mudarDeSala(ws, nova.codigo); enviar(ws, { t: 'cidade', ...vista(nova, pid) }); }
          }
          await gravar(cid);
          avisarCidade(cid);
          return [200, vista(cid, s.pid)];
        }
        if (!ele || outro === s.pid) return [404, { erro: 'pid' }];
        if (acao === 'pedir') {
          if (eu.parceiro || ele.parceiro) return [409, { erro: 'ja_tem' }];
          if (!ele.pedidos.includes(s.pid)) ele.pedidos.push(s.pid);
          await gravar(cid);
          avisarCidade(cid);
          return [200, vista(cid, s.pid)];
        }
        if (acao === 'recusar') {
          eu.pedidos = eu.pedidos.filter((p) => p !== outro);
          await gravar(cid);
          avisarCidade(cid);
          return [200, vista(cid, s.pid)];
        }
        if (acao === 'aceitar') {
          if (!eu.pedidos.includes(outro)) return [409, { erro: 'sem_pedido' }];
          if (eu.parceiro || ele.parceiro) return [409, { erro: 'ja_tem' }];
          eu.pedidos = eu.pedidos.filter((p) => p !== outro);
          ele.pedidos = (ele.pedidos || []).filter((p) => p !== s.pid);
          eu.parceiro = outro;
          ele.parceiro = s.pid;
          eu.casa = ele.casa;   // vai morar na casa de quem pediu; a minha fica livre
          await gravar(cid);
          avisarCidade(cid);
          return [200, vista(cid, s.pid)];
        }
        return [400, { erro: 'acao' }];
      });
    },
  };

  // ---------------------------------------------------------------- tempo real
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });

  async function aoUpgrade(req, socket, head) {
    const u = new URL(req.url, 'http://x');
    if (u.pathname !== '/ao-vivo') { socket.destroy(); return; }
    let s = null;
    try { s = await sessao({ token: u.searchParams.get('t') || '' }); } catch (e) { console.error('ao-vivo', e.message); }
    if (!s) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => conectou(ws, s));
  }

  function conectou(ws, s) {
    ws.pid = s.pid;
    ws.vivo = true;
    ws.ultimoChat = 0;
    const antigo = aoVivo.get(s.pid);
    if (antigo && antigo.ws !== ws) antigo.ws.close(4000, 'outro_lugar');
    aoVivo.set(s.pid, { ws, pos: null });
    mudarDeSala(ws, s.cid.codigo);
    enviar(ws, { t: 'cidade', ...vista(s.cid, s.pid) });
    espalhar(s.cid.codigo, { t: 'entrou', pid: s.pid }, ws);
    ws.on('pong', () => { ws.vivo = true; });
    ws.on('message', (dados) => {
      let m;
      try { m = JSON.parse(dados.toString('utf8')); } catch { return; }
      if (m.t === 'pos') {
        const pos = { cena: String(m.cena || '').slice(0, 20), dono: String(m.dono || '').slice(0, 12),
          x: Number(m.x) || 0, at: String(m.at || '').slice(0, 30), olha: m.olha === -1 ? -1 : 1, ctl: !!m.ctl };
        const a = aoVivo.get(ws.pid);
        if (a?.ws === ws) a.pos = pos;
        espalhar(ws.sala, { t: 'pos', pid: ws.pid, ...pos }, ws);
      } else if (m.t === 'chat') {
        const texto = String(m.texto || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, MAX_TEXTO_CHAT);
        if (!texto || Date.now() - ws.ultimoChat < 700) return;
        ws.ultimoChat = Date.now();
        const msg = { pid: ws.pid, texto, h: Date.now() };
        const cid = cache.get(ws.sala);
        if (cid) { cid.chat.push(msg); cid.chat = cid.chat.slice(-MAX_CHAT); gravarLogo(cid); }
        espalhar(ws.sala, { t: 'chat', ...msg });
      }
    });
    ws.on('close', () => {
      const a = aoVivo.get(ws.pid);
      if (a?.ws === ws) {
        aoVivo.delete(ws.pid);
        espalhar(ws.sala, { t: 'saiu', pid: ws.pid });
      }
      salas.get(ws.sala)?.delete(ws);
    });
  }

  // derruba conexões mortas (o proxy do Render também fecha ociosas: o ping mantém viva)
  setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.vivo) { ws.terminate(); continue; }
      ws.vivo = false;
      ws.ping();
    }
  }, 25000).unref();

  return { rotas, aoUpgrade, garantir };
}
