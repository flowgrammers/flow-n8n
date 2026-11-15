#!/usr/bin/env node
/**
 * ligar-n8n.js — liga este Claude Code ao harness n8n, por OAuth e sem token estático.
 *
 * O harness n8n é exposto como MCP sobre HTTP. Ele aceita OAuth: responde 401 com
 * `www-authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/…"`,
 * e é o Claude Code que faz o fluxo, pelo `/mcp`. A armadilha é que um
 * `headers.Authorization` escrito à mão no `~/.claude.json` **desliga esse fallback**: o
 * cliente manda o Bearer fixo, o servidor recusa com 401 e a sessão inteira fica sem as
 * ferramentas do n8n — com a aparência de "falta de escopo", que manda consertar a coisa errada.
 * Foi assim que uma instância de treinamento ficou fora do ar com um token vencido.
 *
 * Por isso este script não renova token nenhum: ele constata que o header estático existe e
 * manda **tirá-lo**. O valor do header nunca é lido, impresso nem gravado — só a existência
 * dele. A sondagem do endpoint sai **sem credencial**, de propósito: é ela que prova que o
 * OAuth está oferecido antes de recomendar remover a única autenticação configurada.
 *
 * O script não escreve em `~/.claude.json`. O arquivo é reescrito pelo app em execução, e uma
 * edição por fora corre o risco de ser sobrescrita no fim da sessão; então aqui se imprime o
 * comando e quem roda é a pessoa, no terminal — o mesmo contrato do `ligar-projeto.js`.
 *
 * Uso:
 *   node ligar-n8n.js plano [--cwd <dir>] [--sem-rede]   # diagnostica; não escreve nada
 *   node ligar-n8n.js comandos [--cwd <dir>]             # só imprime os comandos do terminal
 *
 * Saída: 0 já ligado por OAuth · 3 precisa de ação humana · 4 endpoint sem OAuth
 *        5 configuração ilegível
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PADRAO_N8N = /n8n/i;
const TEMPO_SONDA_MS = 15000;
const NOME_SUGERIDO = 'n8n';

/** Onde o Claude Code guarda os MCP de escopo de usuário. */
function caminhoDaConfig() {
  const candidatos = [];
  if (process.env.CLAUDE_CONFIG_DIR) {
    candidatos.push(path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json'));
  }
  candidatos.push(path.join(os.homedir(), '.claude.json'));
  return candidatos.find((c) => fs.existsSync(c)) || candidatos[candidatos.length - 1];
}

/**
 * Existe um `Authorization` fixo? Devolve só o booleano: o valor não sobe para lugar nenhum,
 * nem para a saída, nem para uma variável de vida longa.
 */
function temHeaderEstatico(entrada) {
  const h = entrada && entrada.headers;
  if (!h || typeof h !== 'object') return false;
  return Object.entries(h).some(
    ([k, v]) => /^authorization$/i.test(k) && typeof v === 'string' && v.trim() !== ''
  );
}

function ehDoN8n(nome, entrada) {
  const url = (entrada && entrada.url) || '';
  return PADRAO_N8N.test(nome) || PADRAO_N8N.test(url);
}

/** Todos os MCP de n8n configurados, com o escopo em que cada um vive. */
function acharServidores(config, cwd) {
  const achados = [];
  const colher = (mapa, escopo) => {
    if (!mapa || typeof mapa !== 'object') return;
    for (const [nome, entrada] of Object.entries(mapa)) {
      if (!ehDoN8n(nome, entrada)) continue;
      achados.push({
        escopo,
        nome,
        url: (entrada && entrada.url) || '(sem url)',
        tipo: (entrada && entrada.type) || '(sem type)',
        estatico: temHeaderEstatico(entrada),
      });
    }
  };
  colher(config.mcpServers, 'usuário');
  const projeto = config.projects && config.projects[cwd];
  colher(projeto && projeto.mcpServers, 'projeto');
  return achados;
}

/** Sondagem SEM credencial: o 401 com `resource_metadata` é a prova de que há OAuth. */
async function sondar(url) {
  const corte = AbortSignal.timeout ? AbortSignal.timeout(TEMPO_SONDA_MS) : undefined;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2026-06-18', capabilities: {}, clientInfo: { name: 'ligar-n8n', version: '1' } },
      }),
      signal: corte,
    });
    const desafio = r.headers.get('www-authenticate') || '';
    return { ok: true, status: r.status, oauth: /resource_metadata=/i.test(desafio), desafio };
  } catch (e) {
    return { ok: false, erro: e && e.message ? e.message : String(e) };
  }
}

function comandos(nome, url, estatico) {
  const linhas = [];
  if (estatico) linhas.push(`claude mcp remove ${nome} -s user`);
  linhas.push(`claude mcp add --scope user --transport http ${nome} ${url}`);
  return linhas;
}

function parse(argv) {
  const o = { acao: 'plano', cwd: process.cwd(), semRede: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'plano' || a === 'comandos') o.acao = a;
    else if (a === '--cwd') o.cwd = argv[++i] || o.cwd;
    else if (a === '--sem-rede') o.semRede = true;
  }
  return o;
}

async function main() {
  const o = parse(process.argv.slice(2));
  const cfg = caminhoDaConfig();

  let config;
  try {
    config = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  } catch (e) {
    console.error(`Não consegui ler a configuração do Claude Code em ${cfg}: ${e.message}`);
    process.exit(5);
  }

  const achados = acharServidores(config, o.cwd);

  if (o.acao === 'comandos') {
    const alvo = achados[0];
    for (const linha of comandos(alvo ? alvo.nome : NOME_SUGERIDO, alvo ? alvo.url : '<url do harness n8n>', alvo ? alvo.estatico : false)) {
      console.log(linha);
    }
    process.exit(achados.length && !achados[0].estatico ? 0 : 3);
  }

  console.log(`Configuração lida: ${cfg}`);
  if (!achados.length) {
    console.log('Nenhum MCP de n8n configurado — nem no escopo de usuário, nem neste projeto.');
    console.log('\nPara ligar, rode no terminal:');
    console.log(`  claude mcp add --scope user --transport http ${NOME_SUGERIDO} <url do harness n8n>`);
    console.log('e depois autorize com /mcp dentro do Claude Code.');
    process.exit(3);
  }

  let precisaAcao = false;
  let semOauth = false;

  for (const s of achados) {
    console.log(`\n· ${s.nome}  [escopo ${s.escopo}, ${s.tipo}]`);
    console.log(`  url: ${s.url}`);
    console.log(`  Authorization fixo no arquivo: ${s.estatico ? 'SIM — é ele que desliga o OAuth' : 'não'}`);

    if (o.semRede) {
      console.log('  (sondagem desligada por --sem-rede)');
    } else {
      const p = await sondar(s.url);
      if (!p.ok) {
        console.log(`  sondagem sem credencial: falhou (${p.erro})`);
      } else {
        console.log(`  sondagem sem credencial: HTTP ${p.status}, OAuth ${p.oauth ? 'oferecido' : 'NÃO oferecido'}`);
        if (!p.oauth) semOauth = true;
      }
    }

    if (s.estatico) {
      precisaAcao = true;
      console.log('\n  Rode no terminal, fora da conversa:');
      for (const linha of comandos(s.nome, s.url, true)) console.log(`    ${linha}`);
      console.log('  e autorize com /mcp dentro do Claude Code.');
    } else {
      console.log('  Nada a tirar: autorize com /mcp dentro do Claude Code.');
    }
  }

  if (semOauth && precisaAcao) {
    console.log('\nAtenção: este endpoint não anunciou OAuth. Não tire o header sem um token novo em mãos —');
    console.log('quem emite é o Lucas ou o Ric.');
    process.exit(4);
  }
  process.exit(precisaAcao ? 3 : 0);
}

main();
