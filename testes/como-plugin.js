#!/usr/bin/env node
'use strict';
/**
 * como-plugin.js — prova o cenário que o kit promete: instalado como plugin, o código vive
 * FORA do projeto (no cache do Claude Code) e o projeto só contribui com `.env`, `.secrets/`
 * e a pasta de evidência.
 *
 * Aqui isso é reproduzido sem instalar nada: o processo roda com `cwd` num projeto temporário,
 * chamando o script pelo caminho absoluto do plugin e sem `--raiz`. Se algum caminho estiver
 * amarrado à pasta do kit, cai neste teste.
 */

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const PLUGIN = path.join(RAIZ, 'plugins', 'flow-n8n');
const ESTEIRA = path.join(PLUGIN, 'scripts', 'lib', 'esteira.js');
const { subir } = require('./instancia-falsa.js');

let passaram = 0;
const falhas = [];
async function teste(nome, fn) {
  try { await fn(); passaram++; console.log(`  ok   ${nome}`); }
  catch (e) { falhas.push(nome); console.log(`  FALHOU ${nome}\n       ${e.message}`); }
}

/** Roda COM cwd no projeto e o script fora dele — o cenário do plugin instalado. */
function rodarNoProjeto(args, projeto, ambiente = {}) {
  return new Promise((resolve) => {
    const filho = spawn(process.execPath, [ESTEIRA, ...args], {
      cwd: projeto,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN, N8N_API_URL: '', N8N_API_KEY: '', ...ambiente },
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
  const projeto = fs.mkdtempSync(path.join(os.tmpdir(), 'projeto-cliente-'));
  fs.writeFileSync(path.join(projeto, '.gitignore'), 'node_modules/\n', 'utf8');
  const ambiente = { N8N_API_URL: falsa.url, N8N_API_KEY: falsa.chave };

  console.log('\nO kit rodando de fora do projeto, como plugin instalado');

  const init = await rodarNoProjeto(['init'], projeto);

  await teste('init prepara o projeto, não o kit', () => {
    assert.strictEqual(init.codigo, 0, init.saida);
    const gi = fs.readFileSync(path.join(projeto, '.gitignore'), 'utf8').split('\n');
    assert.ok(gi.includes('.secrets/'), `.gitignore sem .secrets/: ${gi.join(' | ')}`);
    assert.ok(gi.includes('.env'), '.gitignore sem .env');
    assert.ok(gi.includes('node_modules/'), 'o init apagou o que já havia no .gitignore');
    assert.ok(fs.existsSync(path.join(projeto, 'docs', 'evidencias')), 'faltou docs/evidencias no projeto');
  });

  await teste('init não escreve .env nenhum — a chave é da pessoa', () => {
    assert.ok(!fs.existsSync(path.join(projeto, '.env')), 'o init criou um .env');
    assert.ok(init.saida.includes('N8N_API_URL='), 'o init não disse quais variáveis preencher');
  });

  const ciclo = await rodarNoProjeto(
    ['ciclo', '--spec', path.join(PLUGIN, 'exemplos', 'eco.json'), '--sem-prints'],
    projeto,
    ambiente,
  );

  await teste('o ciclo roda sem --raiz e a evidência cai no PROJETO', () => {
    assert.strictEqual(ciclo.codigo, 0, ciclo.saida);
    const pastas = fs.readdirSync(path.join(projeto, 'docs', 'evidencias'));
    assert.strictEqual(pastas.length, 1, `esperava uma rodada no projeto: ${pastas.join(', ')}`);
    const dir = path.join(projeto, 'docs', 'evidencias', pastas[0]);
    assert.ok(fs.existsSync(path.join(dir, 'INDICE.md')), 'faltou o índice');
    const indice = fs.readFileSync(path.join(dir, 'INDICE.md'), 'utf8');
    assert.ok(indice.includes('todos os passos passaram'), indice.slice(0, 600));
  });

  await teste('nada foi escrito dentro do kit', () => {
    const dentroDoKit = path.join(RAIZ, 'docs', 'evidencias');
    const antes = fs.existsSync(dentroDoKit) ? fs.readdirSync(dentroDoKit) : [];
    const doProjeto = fs.readdirSync(path.join(projeto, 'docs', 'evidencias'));
    for (const r of doProjeto) {
      assert.ok(!antes.includes(r), `a rodada ${r} vazou para a pasta do kit`);
    }
  });

  await teste('o exemplo viaja com o plugin', () => {
    assert.ok(fs.existsSync(path.join(PLUGIN, 'exemplos', 'eco.json')),
      'o exemplo não está dentro do plugin — instalado, o comando não o acharia');
  });

  await teste('sem .env no projeto, a esteira recusa em vez de usar a do kit', async () => {
    const outro = fs.mkdtempSync(path.join(os.tmpdir(), 'projeto-sem-env-'));
    const r = await rodarNoProjeto(['preparar'], outro);
    assert.strictEqual(r.codigo, 4, `esperava 4 (ambiente incompleto), veio ${r.codigo}: ${r.saida}`);
  });

  await falsa.parar();
  console.log(`\n${passaram} passaram, ${falhas.length} falharam\n`);
  process.exit(falhas.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
