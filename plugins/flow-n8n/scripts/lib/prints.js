'use strict';
/**
 * prints.js — os prints de tela da esteira, com Playwright.
 *
 * O editor do n8n exige sessão. A regra aqui é dura e não negociável: **a IA não digita
 * senha**. Então o kit faz assim:
 *
 *   1. `esteira login` abre um navegador VISÍVEL e para na tela de login do n8n.
 *   2. A pessoa digita usuário e senha ali, na tela do próprio n8n.
 *   3. O script detecta que entrou e grava a sessão em `.secrets/n8n-sessao.json`
 *      (pasta no .gitignore). O valor da senha nunca passa pelo script.
 *   4. Os prints seguintes rodam sem navegador visível, reusando essa sessão.
 *
 * Sessão expira. Quando expirar, o print sai na tela de login e o script detecta isso e
 * falha com instrução de rodar o login outra vez — em vez de salvar um print inútil.
 */

const fs = require('fs');
const path = require('path');

const ARQUIVO_SESSAO = path.join('.secrets', 'n8n-sessao.json');
const ESPERA_LOGIN_MS = 5 * 60 * 1000;
const ESPERA_TELA_MS = 45000;

function baseDaUi() {
  const url = (process.env.N8N_UI_URL || process.env.N8N_API_URL || '').trim();
  if (!url) {
    const e = new Error('falta N8N_UI_URL (ou N8N_API_URL) para saber qual editor abrir.');
    e.code = 'AMBIENTE_INCOMPLETO';
    throw e;
  }
  return url.replace(/\/+$/, '');
}

/**
 * Acha o Playwright. Instalado como plugin, o kit vive no cache do Claude Code, onde não há
 * `node_modules` — quem tem é o PROJETO que está usando o kit. Por isso a busca é, nesta ordem:
 * o próprio kit (uso a partir da pasta clonada), o projeto, e a instalação global.
 */
function carregarPlaywright(raiz = process.cwd()) {
  const caminhos = [raiz, path.join(raiz, 'node_modules'), path.resolve(__dirname, '..', '..', '..', '..')];
  try {
    return require('playwright');
  } catch { /* segue para a busca pelo projeto */ }
  try {
    return require(require.resolve('playwright', { paths: caminhos }));
  } catch { /* segue para a mensagem */ }
  const e = new Error(
    'Playwright não encontrado. No projeto onde você vai rodar a esteira:\n' +
    '    npm install --save-dev playwright && npx playwright install chromium\n' +
    '  Sem ele o ciclo roda igual: só o passo de print sai como aviso.'
  );
  e.code = 'PLAYWRIGHT_AUSENTE';
  throw e;
}

function caminhoSessao(raiz = process.cwd()) {
  return path.join(raiz, ARQUIVO_SESSAO);
}

function temSessao(raiz = process.cwd()) {
  return fs.existsSync(caminhoSessao(raiz));
}

/** Entrou de fato? O editor do n8n mostra a barra lateral só com sessão válida. */
async function pareceLogado(pagina) {
  const marcas = ['[data-test-id="main-sidebar"]', '[data-test-id="workflow-canvas"]', '#sidebar'];
  for (const m of marcas) {
    if (await pagina.locator(m).first().isVisible().catch(() => false)) return true;
  }
  return false;
}

async function naTelaDeLogin(pagina) {
  const url = pagina.url();
  if (/\/sign(in|up)\b/.test(url)) return true;
  return pagina.locator('input[type="password"]').first().isVisible().catch(() => false);
}

/**
 * Abre o navegador para a PESSOA logar e guarda a sessão.
 * Não preenche campo nenhum: só espera e confere.
 */
async function login({ raiz = process.cwd(), aoVivo = true } = {}) {
  const { chromium } = carregarPlaywright(raiz);
  const base = baseDaUi();
  const navegador = await chromium.launch({ headless: !aoVivo });
  const contexto = await navegador.newContext({ viewport: { width: 1600, height: 1000 } });
  const pagina = await contexto.newPage();
  await pagina.goto(`${base}/signin`, { waitUntil: 'domcontentloaded' }).catch(() => {});

  const limite = Date.now() + ESPERA_LOGIN_MS;
  let entrou = false;
  while (Date.now() < limite) {
    if (await pareceLogado(pagina)) { entrou = true; break; }
    await pagina.waitForTimeout(1500);
  }

  if (!entrou) {
    await navegador.close();
    const e = new Error('o login não se completou na janela aberta (esperei 5 minutos).');
    e.code = 'LOGIN_NAO_CONCLUIDO';
    throw e;
  }

  const destino = caminhoSessao(raiz);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  await contexto.storageState({ path: destino });
  fs.chmodSync(destino, 0o600);
  await navegador.close();
  return { arquivo: destino, instancia: base };
}

/**
 * Espera QUALQUER um dos seletores aparecer. Devolve true se algum apareceu — o chamador
 * registra isso na evidência, para distinguir print cheio de print de tela em branco.
 */
async function esperarConteudo(pagina, seletores, limite = 25000) {
  if (!seletores || !seletores.length) return false;
  const fim = Date.now() + limite;
  while (Date.now() < fim) {
    for (const s of seletores) {
      if (await pagina.locator(s).first().isVisible().catch(() => false)) return true;
    }
    await pagina.waitForTimeout(500);
  }
  return false;
}

/** Tira da frente o banner de novidade do n8n, que cobre o topo do editor. */
async function fecharBanners(pagina) {
  const fechar = ['[data-test-id="banner-close"]', '.el-notification__closeBtn', 'button[aria-label="close"]'];
  for (const s of fechar) {
    const alvo = pagina.locator(s).first();
    if (await alvo.isVisible().catch(() => false)) await alvo.click().catch(() => {});
  }
}

/**
 * Tira os prints de uma rodada. `alvos` é uma lista de { nome, caminhoUrl }.
 * Devolve os arquivos gravados, para o índice da evidência.
 */
async function capturar({ alvos, rodada, raiz = process.cwd() }) {
  const { chromium } = carregarPlaywright(raiz);
  const base = baseDaUi();
  if (!temSessao(raiz)) {
    const e = new Error('não há sessão salva. Rode o passo `login` da esteira antes dos prints.');
    e.code = 'SESSAO_AUSENTE';
    throw e;
  }

  const navegador = await chromium.launch({ headless: true });
  const contexto = await navegador.newContext({
    storageState: caminhoSessao(raiz),
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
  });
  const pagina = await contexto.newPage();
  const feitos = [];

  try {
    for (const alvo of alvos) {
      const url = `${base}${alvo.caminhoUrl}`;
      await pagina.goto(url, { waitUntil: 'domcontentloaded', timeout: ESPERA_TELA_MS });

      if (await naTelaDeLogin(pagina)) {
        const e = new Error('a sessão salva expirou — o editor devolveu a tela de login. Rode o `login` outra vez.');
        e.code = 'SESSAO_EXPIRADA';
        throw e;
      }

      // Print de editor carregando não é evidência: a primeira captura do canvas saiu com a
      // tela vazia porque o Vue ainda montava os nós. Espera-se o conteúdo, não o relógio.
      const esperado = await esperarConteudo(pagina, alvo.esperarPor);
      await fecharBanners(pagina);
      await pagina.waitForTimeout(1200);

      const { arquivo, caminho } = rodada.caminhoPara(alvo.nome, 'png');
      await pagina.screenshot({ path: caminho, fullPage: false });
      feitos.push({ nome: alvo.nome, arquivo, url, conteudoConfirmado: esperado });
    }
  } finally {
    await navegador.close();
  }

  return feitos;
}

module.exports = { login, capturar, temSessao, caminhoSessao, baseDaUi, ARQUIVO_SESSAO };
