#!/usr/bin/env node
'use strict';
/**
 * ciclo-contra-falsa.js — roda o ciclo INTEIRO contra a instância falsa e audita a evidência.
 *
 * É o teste que prova o produto: não que as funções compilam, mas que uma rodada da esteira
 * produz a pasta com payload, resposta, execução e índice — e que o workflow termina inativo,
 * porque publicar é passo separado e exige OK.
 *
 * O filho roda com `spawn`, não com `execFileSync`: a instância falsa vive NESTE processo, e
 * uma chamada síncrona travaria o event loop que precisa atender o HTTP. Servidor e cliente no
 * mesmo processo, um esperando o outro — foi exatamente o que aconteceu na primeira versão.
 */

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const ESTEIRA = path.join(RAIZ, 'plugins', 'flow-n8n', 'scripts', 'lib', 'esteira.js');
const { subir } = require('./instancia-falsa.js');

let passaram = 0;
const falhas = [];

async function teste(nome, fn) {
  try { await fn(); passaram++; console.log(`  ok   ${nome}`); }
  catch (e) { falhas.push(nome); console.log(`  FALHOU ${nome}\n       ${e.message}`); }
}

function rodar(args, ambiente) {
  return new Promise((resolve) => {
    const filho = spawn(process.execPath, [ESTEIRA, ...args], {
      env: { ...process.env, ...ambiente },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let saida = '';
    filho.stdout.on('data', (d) => { saida += d; });
    filho.stderr.on('data', (d) => { saida += d; });
    filho.on('close', (codigo) => resolve({ codigo, saida }));
  });
}

(async () => {
  const falsa = await subir();
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'ciclo-'));
  const ambiente = { N8N_API_URL: falsa.url, N8N_API_KEY: falsa.chave, N8N_UI_URL: falsa.url };

  console.log('\nCiclo completo contra a instância falsa');

  const r = await rodar(
    ['ciclo', '--spec', path.join(RAIZ, 'plugins', 'flow-n8n', 'exemplos', 'eco.json'), '--raiz', raiz, '--sem-prints'],
    ambiente,
  );

  await teste('o ciclo termina com sucesso', () => {
    assert.strictEqual(r.codigo, 0, `saiu ${r.codigo}:\n${r.saida}`);
  });

  const pastas = fs.readdirSync(path.join(raiz, 'docs', 'evidencias'));
  await teste('gravou uma pasta de evidência em docs/evidencias', () => {
    assert.strictEqual(pastas.length, 1, `pastas: ${pastas.join(', ')}`);
  });

  const dir = path.join(raiz, 'docs', 'evidencias', pastas[0]);
  const arquivos = fs.readdirSync(dir).sort();
  const achar = (padrao) => {
    const a = arquivos.find((x) => padrao.test(x));
    assert.ok(a, `faltou arquivo casando ${padrao} — tem: ${arquivos.join(', ')}`);
    return JSON.parse(fs.readFileSync(path.join(dir, a), 'utf8'));
  };

  await teste('a evidência tem payload, resposta, workflow e execução', () => {
    for (const padrao of [
      /sonda-da-instancia\.json$/,
      /workflow-enviado\.json$/,
      /workflow-criado\.json$/,
      /workflow-no-n8n\.json$/,
      /payload-enviado\.json$/,
      /resposta-do-webhook\.json$/,
      /execucao-no-n8n\.json$/,
    ]) {
      assert.ok(arquivos.some((a) => padrao.test(a)), `faltou ${padrao} — tem: ${arquivos.join(', ')}`);
    }
  });

  await teste('o índice marca todos os passos como ok e declara a ativação temporária', () => {
    const indice = fs.readFileSync(path.join(dir, 'INDICE.md'), 'utf8');
    assert.ok(indice.includes('todos os passos passaram'), indice.slice(0, 900));
    assert.ok(indice.includes('Ativação **temporária**'), 'o índice não declara que a ativação foi temporária');
    assert.ok(indice.includes('Desativar depois do teste'), 'faltou o passo de desativar');
    assert.ok(/\| 1 \| Sondar a instância \|/.test(indice), 'faltou o passo da sonda');
  });

  await teste('a resposta do webhook guardada é a do workflow', () => {
    const dados = achar(/resposta-do-webhook\.json$/);
    assert.strictEqual(dados.status, 200, JSON.stringify(dados).slice(0, 400));
    assert.strictEqual(dados.corpo.origem, 'flow-n8n-harness');
    assert.strictEqual(dados.corpo.recebido.teste, true, 'o eco não trouxe o payload enviado');
  });

  await teste('a execução guardada traz o dado de cada nó', () => {
    const dados = achar(/execucao-no-n8n\.json$/);
    assert.strictEqual(dados.status, 'success');
    assert.ok(dados.data?.['Montar o eco'], `faltou o nó: ${Object.keys(dados.data || {})}`);
  });

  await teste('o workflow fica INATIVO no fim do ciclo', () => {
    const wfs = [...falsa.workflows.values()];
    assert.strictEqual(wfs.length, 1, `workflows criados: ${wfs.length}`);
    assert.strictEqual(wfs[0].active, false, 'o ciclo deixou o workflow ativo — publicação sem OK');
  });

  await teste('a chave da API não aparece em nenhum arquivo da evidência', () => {
    for (const a of arquivos) {
      assert.ok(!fs.readFileSync(path.join(dir, a), 'utf8').includes(falsa.chave), `a chave vazou em ${a}`);
    }
  });

  console.log('\nFidelidade da instância falsa');

  const id = [...falsa.workflows.keys()][0];

  await teste('webhook de produção devolve 404 com o workflow inativo', async () => {
    const resp = await fetch(`${falsa.url}/webhook/flow-n8n-harness-eco`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.strictEqual(resp.status, 404, 'inativo deveria recusar — a ativação do ciclo seria enfeite');
  });

  console.log('\nO portão da publicação, com a instância no ar');

  await teste('publicar sem --ok sai 3 e o workflow continua inativo', async () => {
    const p = await rodar(['publicar', '--id', id, '--raiz', raiz], ambiente);
    assert.strictEqual(p.codigo, 3, p.saida);
    assert.strictEqual(falsa.workflows.get(id).active, false, 'ativou sem OK');
  });

  await teste('publicar com --ok ativa e grava a evidência da publicação', async () => {
    const p = await rodar(['publicar', '--id', id, '--ok', '--raiz', raiz], ambiente);
    assert.strictEqual(p.codigo, 0, p.saida);
    assert.strictEqual(falsa.workflows.get(id).active, true, 'não ativou com OK');
    const agora = fs.readdirSync(path.join(raiz, 'docs', 'evidencias'));
    const pub = agora.find((d) => d.includes('publicacao'));
    assert.ok(pub, `a publicação não gerou pasta própria: ${agora.join(', ')}`);
    const indice = fs.readFileSync(path.join(raiz, 'docs', 'evidencias', pub, 'INDICE.md'), 'utf8');
    assert.ok(indice.includes('Estado agora: **ativo**'), indice.slice(0, 700));
  });

  await falsa.parar();
  console.log(`\n${passaram} passaram, ${falhas.length} falharam`);
  console.log(`evidência da rodada: ${dir}\n`);
  process.exit(falhas.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
