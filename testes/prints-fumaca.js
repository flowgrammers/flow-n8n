#!/usr/bin/env node
'use strict';
/**
 * prints-fumaca.js — prova que o caminho do print funciona nesta máquina: sobe o Chromium,
 * carrega uma página local, grava PNG na pasta de evidência e confere que o arquivo tem
 * cara de PNG. Sem rede e sem n8n. Fica fora da suíte principal porque depende de
 * navegador instalado; `npm run teste` continua rodando em qualquer máquina.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const { abrirRodada } = require(path.join(RAIZ, 'plugins/flow-n8n/scripts/lib/evidencia.js'));

(async () => {
  const { chromium } = require('playwright');
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'fumaca-'));
  const rodada = abrirRodada({ slug: 'fumaca-de-print', raiz, titulo: 'Fumaça do print' });

  const navegador = await chromium.launch({ headless: true });
  const pagina = await navegador.newPage({ viewport: { width: 800, height: 400 } });
  await pagina.setContent('<h1 style="font:700 48px system-ui;padding:60px">esteira: print ok</h1>');
  const { arquivo, caminho } = rodada.caminhoPara('pagina-de-prova', 'png');
  await pagina.screenshot({ path: caminho });
  await navegador.close();

  const bytes = fs.readFileSync(caminho);
  assert.ok(bytes.length > 1000, 'o PNG saiu vazio');
  assert.strictEqual(bytes.slice(1, 4).toString('ascii'), 'PNG', 'o arquivo não é PNG');
  rodada.passo({ etapa: 'Print de prova', situacao: 'ok', arquivos: [arquivo],
    detalhe: `${bytes.length} bytes de PNG, gravados pelo mesmo caminho que a esteira usa.` });
  const indice = rodada.escreverIndice({ instancia: '(nenhuma — teste local)' });

  console.log(`  ok   Chromium subiu e gravou ${arquivo} (${bytes.length} bytes)`);
  console.log(`  ok   índice em ${indice}`);
})().catch((e) => { console.error(`  FALHOU ${e.message}`); process.exit(1); });
