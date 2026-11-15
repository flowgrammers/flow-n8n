'use strict';
/**
 * evidencia.js — a pasta de evidência de uma rodada da esteira.
 *
 * O contrato é simples e rígido: **cada passo da esteira grava arquivo**. Payload enviado,
 * resposta recebida, JSON do workflow, execução do n8n e print de tela. No fim sai um
 * `INDICE.md` que amarra tudo em ordem, com o que passou e o que falhou — é esse arquivo
 * que vai ao cliente, não a memória da sessão.
 *
 * Tudo que entra passa por `redigir()`. A chave da API nunca é escrita, e qualquer campo com
 * cara de segredo (senha, token, authorization, apiKey…) vira «redigido». Isso é o que
 * permite versionar a evidência: ela nasce publicável.
 */

const fs = require('fs');
const path = require('path');

const CHAVES_SENSIVEIS =
  /(senha|password|passwd|secret|token|apikey|api[_-]?key|authorization|auth|credential|privatekey|private[_-]?key|cookie|sessionid)/i;

const MARCA = '«redigido»';

/** Marca de tempo local, em formato que ordena: 2026-11-14-0930. */
function selo(agora = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${agora.getFullYear()}-${p(agora.getMonth() + 1)}-${p(agora.getDate())}-${p(agora.getHours())}${p(agora.getMinutes())}`;
}

function aoSlug(texto) {
  return String(texto || 'rodada')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'rodada';
}

/**
 * Redige em profundidade. Além das chaves sensíveis, compara cada string com os segredos
 * do ambiente: um token que vaze para dentro de um payload de resposta também cai aqui.
 */
function redigir(valor, segredos = segredosDoAmbiente()) {
  const visto = new WeakSet();
  const limpar = (v) => {
    if (typeof v === 'string') {
      let s = v;
      for (const seg of segredos) if (seg && s.includes(seg)) s = s.split(seg).join(MARCA);
      return s;
    }
    if (Array.isArray(v)) return v.map(limpar);
    if (v && typeof v === 'object') {
      if (visto.has(v)) return '«ciclo»';
      visto.add(v);
      const saida = {};
      for (const [k, item] of Object.entries(v)) {
        saida[k] = CHAVES_SENSIVEIS.test(k) ? MARCA : limpar(item);
      }
      return saida;
    }
    return v;
  };
  return limpar(valor);
}

function segredosDoAmbiente() {
  return [process.env.N8N_API_KEY, process.env.N8N_SENHA, process.env.N8N_PASSWORD]
    .map((s) => (s || '').trim())
    .filter((s) => s.length >= 8);
}

/**
 * Abre a rodada. `raiz` é o projeto que está USANDO o kit — a evidência mora lá,
 * em `docs/evidencias/`, não dentro do kit.
 */
function abrirRodada({ slug, raiz = process.cwd(), titulo }) {
  // Duas rodadas no mesmo minuto cairiam na mesma pasta e a numeração sobrescreveria a
  // evidência anterior — perda silenciosa, que é o pior tipo. Pasta ocupada ganha sufixo.
  const base = `${selo()}-${aoSlug(slug)}`;
  let nome = base;
  let dir = path.join(raiz, 'docs', 'evidencias', nome);
  for (let n = 2; fs.existsSync(dir); n++) {
    nome = `${base}-${n}`;
    dir = path.join(raiz, 'docs', 'evidencias', nome);
  }
  fs.mkdirSync(dir, { recursive: true });
  const passos = [];
  let ordem = 0;

  const proximoPrefixo = () => String(++ordem).padStart(2, '0');

  function salvarJson(nomeArquivo, dados) {
    const arquivo = `${proximoPrefixo()}-${aoSlug(nomeArquivo)}.json`;
    fs.writeFileSync(path.join(dir, arquivo), JSON.stringify(redigir(dados), null, 2) + '\n', 'utf8');
    return arquivo;
  }

  function salvarTexto(nomeArquivo, texto, extensao = 'txt') {
    const arquivo = `${proximoPrefixo()}-${aoSlug(nomeArquivo)}.${extensao}`;
    const limpo = redigir(String(texto));
    fs.writeFileSync(path.join(dir, arquivo), limpo.endsWith('\n') ? limpo : limpo + '\n', 'utf8');
    return arquivo;
  }

  /** Reserva um caminho para quem escreve binário (o Playwright, por exemplo). */
  function caminhoPara(nomeArquivo, extensao) {
    const arquivo = `${proximoPrefixo()}-${aoSlug(nomeArquivo)}.${extensao}`;
    return { arquivo, caminho: path.join(dir, arquivo) };
  }

  function passo({ etapa, situacao, detalhe, arquivos = [] }) {
    passos.push({ etapa, situacao, detalhe: detalhe || '', arquivos, quando: new Date().toISOString() });
  }

  function escreverIndice({ resumo = '', instancia = '', workflow = null } = {}) {
    const icone = { ok: '✅', falhou: '❌', pulado: '⏭️', aviso: '⚠️' };
    const l = [];
    l.push(`# Evidência — ${titulo || slug}`);
    l.push('');
    l.push(`Rodada \`${nome}\` · gerada pela esteira do \`flow-n8n-harness\`.`);
    l.push('');
    if (instancia) l.push(`- **Instância n8n**: ${instancia}`);
    if (workflow?.id) l.push(`- **Workflow**: \`${workflow.id}\` — ${workflow.name || '(sem nome)'}`);
    l.push(`- **Passos registrados**: ${passos.length}`);
    const falhas = passos.filter((p) => p.situacao === 'falhou').length;
    l.push(`- **Resultado**: ${falhas === 0 ? 'todos os passos passaram' : `${falhas} passo(s) falharam`}`);
    l.push('');
    if (resumo) { l.push(resumo); l.push(''); }
    l.push('## Passos');
    l.push('');
    l.push('| # | Etapa | Situação | Evidência |');
    l.push('|---|---|---|---|');
    passos.forEach((p, i) => {
      const links = p.arquivos.length
        ? p.arquivos.map((a) => `[\`${a}\`](./${a})`).join(' · ')
        : '—';
      l.push(`| ${i + 1} | ${p.etapa} | ${icone[p.situacao] || ''} ${p.situacao} | ${links} |`);
    });
    l.push('');
    const comDetalhe = passos.filter((p) => p.detalhe);
    if (comDetalhe.length) {
      l.push('## Detalhe por passo');
      l.push('');
      for (const p of comDetalhe) {
        l.push(`### ${p.etapa}`);
        l.push('');
        l.push(redigir(p.detalhe));
        l.push('');
      }
    }
    l.push('---');
    l.push('');
    l.push('Segredos não entram nesta pasta: a chave da API e todo campo com nome de credencial');
    l.push('saem como «redigido» antes da gravação. Por isso a evidência nasce publicável.');
    l.push('');
    fs.writeFileSync(path.join(dir, 'INDICE.md'), l.join('\n'), 'utf8');
    return path.join(dir, 'INDICE.md');
  }

  return { nome, dir, salvarJson, salvarTexto, caminhoPara, passo, escreverIndice, passos };
}

module.exports = { abrirRodada, redigir, selo, aoSlug, MARCA };
