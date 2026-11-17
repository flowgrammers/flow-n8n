#!/usr/bin/env node
'use strict';
/**
 * esteira.js — o ciclo completo de um workflow n8n, com evidência de cada passo.
 *
 *   criar → ativar para teste → disparar → ler a execução → desativar → prints → índice
 *   e, só depois e só com OK da pessoa, publicar.
 *
 * Três regras que o código impõe, não sugere:
 *
 * 1. **Publicar exige OK explícito.** `publicar` sem `--ok` não ativa nada: imprime o que
 *    faria e sai com 3. Quem decide ligar um workflow na instância é a pessoa.
 * 2. **Teste não é publicação.** Webhook de produção só responde com o workflow ativo, então
 *    o teste ativa — e DESATIVA no fim, sempre, inclusive se o disparo falhar. O índice diz
 *    que a ativação foi temporária.
 * 3. **Passo sem arquivo não existe.** Cada etapa grava payload, resposta ou print em
 *    `docs/evidencias/<rodada>/`. É o índice que prova a entrega, não a conversa.
 *
 * Uso:
 *   esteira.js init [--raiz <dir>]
 *   esteira.js preparar [--raiz <dir>]
 *   esteira.js login [--raiz <dir>]
 *   esteira.js ciclo --spec <arq.json> [--payload <arq.json>] [--slug <nome>] [--sem-prints]
 *   esteira.js prints --id <workflow> [--raiz <dir>]
 *   esteira.js publicar --id <workflow> --ok [--raiz <dir>]
 *   esteira.js limpar --id <workflow> --ok
 *
 * Saída: 0 tudo passou · 2 erro de uso · 3 falta o OK humano · 4 ambiente incompleto
 *        5 algum passo do ciclo falhou
 */

const fs = require('fs');
const path = require('path');
const n8n = require('./n8n');
const { abrirRodada } = require('./evidencia');
const prints = require('./prints');
const padroes = require('./padroes');
const crypto = require('crypto');

const ESPERA_EXECUCAO_MS = 20000;

/**
 * Prepara a cópia que vai para a instância. A definição em disco não muda.
 *
 * 1. **Path de webhook único por rodada.** O n8n recusa ativar dois workflows com o mesmo
 *    path (`409 conflict with one of the webhooks`). Com path fixo, uma rodada anterior que
 *    ficou ativa trava todas as seguintes — foi o que aconteceu no training em 16/11. O
 *    sufixo e o `webhookId` novo isolam cada rodada.
 * 2. **`availableInMCP` ligado por padrão.** Workflow criado pela API nasce invisível ao MCP,
 *    e é pelo MCP (`test_workflow`) que se dispara o que não tem webhook. A spec pode desligar.
 */
function prepararParaTeste(definicao, sufixo) {
  const copia = JSON.parse(JSON.stringify(definicao));
  const trocas = [];
  for (const no of copia.nodes || []) {
    if (no.type !== 'n8n-nodes-base.webhook') continue;
    const antes = no.parameters?.path;
    if (typeof antes !== 'string' || !antes.trim()) continue;
    no.parameters.path = `${antes.trim().replace(/\/+$/, '')}-${sufixo}`;
    no.webhookId = crypto.randomUUID();
    trocas.push({ no: no.name, de: antes, para: no.parameters.path });
  }
  copia.settings = { ...(copia.settings || {}) };
  if (copia.settings.availableInMCP === undefined) copia.settings.availableInMCP = true;
  return { definicao: copia, trocas };
}

/**
 * Carrega o `.env` para o ambiente. O Node não faz isso sozinho, e o README manda copiar
 * `.env.example` para `.env` — sem este carregador a esteira sairia com 4 mesmo com o arquivo
 * preenchido. Procura APENAS no projeto que está usando o kit.
 *
 * O parser é à mão de propósito: `process.loadEnvFile` **não** sobrescreve variável já
 * presente no ambiente, e variável presente-mas-vazia (`N8N_API_URL=`) é o caso comum de quem
 * exportou o nome sem valor. Aqui vazio conta como ausente. Nenhum valor é impresso.
 */
function carregarEnv(raiz) {
  // Só o `.env` do projeto em que a esteira está rodando. O do kit NÃO entra como reserva:
  // senão um projeto sem `.env` usaria a instância do kit em silêncio — exatamente o que a
  // regra de "nenhuma instância embutida" existe para impedir. A suíte prova isso.
  const candidatos = [path.join(raiz, '.env')];
  for (const arquivo of candidatos) {
    if (!fs.existsSync(arquivo)) continue;
    let texto;
    try {
      texto = fs.readFileSync(arquivo, 'utf8');
    } catch {
      continue; // .env ilegível não derruba a esteira: quem reclama é exigirAmbiente().
    }
    for (const linha of texto.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(linha);
      if (!m) continue;
      const chave = m[1];
      if (process.env[chave]) continue; // o ambiente vence o arquivo
      const valor = m[2].trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
      if (valor) process.env[chave] = valor;
    }
  }
}

function argumentos(lista) {
  const fora = { _: [] };
  for (let i = 0; i < lista.length; i++) {
    const a = lista[i];
    if (a === '--ok') fora.ok = true;
    else if (a === '--sem-prints') fora.semPrints = true;
    else if (a === '--sem-ativar') fora.semAtivar = true;
    else if (a.startsWith('--')) fora[a.slice(2)] = lista[++i];
    else fora._.push(a);
  }
  return fora;
}

function lerJson(arquivo) {
  const texto = fs.readFileSync(arquivo, 'utf8');
  try {
    return JSON.parse(texto);
  } catch (e) {
    throw new Error(`${arquivo} não é JSON válido: ${e.message}`);
  }
}

function hostDe(url) {
  try { return new URL(url).host; } catch { return String(url); }
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Ativar não é o mesmo que estar atendendo. O `POST /activate` responde antes de o webhook
 * estar registrado, e numa instância com processo de webhook separado isso leva segundos.
 * Disparar em seguida devolve o 404 "not registered" do próprio n8n — foi o que aconteceu na
 * primeira rodada contra uma instância real, 50 ms depois de ativar.
 */
async function esperarAtivo(workflowId, limite = 15000) {
  const fim = Date.now() + limite;
  while (Date.now() < fim) {
    const wf = await n8n.obterWorkflow(workflowId).catch(() => null);
    if (wf?.active) return true;
    await dormir(1000);
  }
  return false;
}

/** Dispara o webhook repetindo enquanto o n8n responder 404 de webhook não registrado. */
async function dispararComRepeticao({ caminhoWebhook, payload, tentativas = 6, intervaloMs = 2000 }) {
  let ultima = null;
  for (let i = 1; i <= tentativas; i++) {
    ultima = await n8n.chamarWebhook({ caminhoWebhook, payload, modo: 'producao' });
    ultima.tentativa = i;
    if (ultima.status !== 404) return ultima;
    if (i < tentativas) await dormir(intervaloMs);
  }
  return ultima;
}

/** Espera a execução aparecer: o n8n registra com alguns instantes de atraso. */
async function esperarExecucao(workflowId, limite = ESPERA_EXECUCAO_MS) {
  const fim = Date.now() + limite;
  while (Date.now() < fim) {
    const lista = await n8n.execucoesDoWorkflow(workflowId, 3).catch(() => null);
    const primeira = lista?.data?.[0];
    if (primeira?.id) return primeira;
    await dormir(1500);
  }
  return null;
}

async function comandoPreparar(op) {
  const raiz = path.resolve(op.raiz || process.cwd());
  const rodada = abrirRodada({ slug: 'preparar', raiz, titulo: 'Preparação do ambiente' });
  const { base } = n8n.exigirAmbiente();
  let arquivo;
  try {
    const sonda = await n8n.sondar();
    arquivo = rodada.salvarJson('sonda-da-instancia', { instancia: hostDe(base), ...sonda });
    rodada.passo({ etapa: 'Sondar a instância', situacao: 'ok', arquivos: [arquivo],
      detalhe: `A credencial responde em \`${hostDe(base)}\` e lista workflows.` });
  } catch (e) {
    arquivo = rodada.salvarJson('sonda-da-instancia', { instancia: hostDe(base), erro: e.message });
    rodada.passo({ etapa: 'Sondar a instância', situacao: 'falhou', arquivos: [arquivo], detalhe: e.message });
    rodada.escreverIndice({ instancia: hostDe(base) });
    console.error(`[esteira] a instância recusou: ${e.message}`);
    console.error(`[esteira] evidência em ${rodada.dir}`);
    return 5;
  }

  const sessao = prints.temSessao(raiz);
  rodada.passo({
    etapa: 'Sessão do editor para os prints',
    situacao: sessao ? 'ok' : 'aviso',
    detalhe: sessao
      ? `Sessão salva em \`${prints.ARQUIVO_SESSAO}\`; os prints rodam sem janela.`
      : 'Não há sessão salva. Rode `esteira login` e faça o login você mesmo — a esteira não digita senha.',
  });

  rodada.escreverIndice({ instancia: hostDe(base) });
  console.log(`[esteira] ambiente ok em ${hostDe(base)}`);
  console.log(`[esteira] prints: ${sessao ? 'sessão presente' : 'FALTA login (rode: esteira login)'}`);
  console.log(`[esteira] evidência: ${rodada.dir}`);
  return 0;
}

async function comandoLogin(op) {
  const raiz = path.resolve(op.raiz || process.cwd());
  console.log('[esteira] abrindo o editor do n8n numa janela. Faça o login você mesmo:');
  console.log('[esteira] a esteira não digita senha, não lê o campo e não guarda a credencial —');
  console.log('[esteira] guarda só o cookie de sessão, em .secrets/ (fora do Git).');
  const r = await prints.login({ raiz, aoVivo: true });
  console.log(`[esteira] sessão gravada em ${r.arquivo} (instância ${hostDe(r.instancia)})`);
  return 0;
}

/** Desativa o workflow que o ciclo ligou para o teste e registra o passo. Devolve se deu certo. */
async function desativarDepoisDoTeste(rodada, workflowId) {
  const r = await n8n.desativar(workflowId).then(() => 'ok').catch((e) => e.message);
  rodada.passo({ etapa: 'Desativar depois do teste', situacao: r === 'ok' ? 'ok' : 'falhou',
    detalhe: r === 'ok'
      ? 'Workflow de volta a inativo, antes dos prints. Publicar é passo separado, e exige o seu OK.'
      : `Não consegui desativar: ${r}. Confira na instância.` });
  return r === 'ok';
}

async function comandoCiclo(op) {
  if (!op.spec) { console.error('[esteira] falta --spec <arquivo.json> com a definição do workflow.'); return 2; }
  const raiz = path.resolve(op.raiz || process.cwd());
  const definicao = lerJson(path.resolve(op.spec));
  const payload = op.payload
    ? lerJson(path.resolve(op.payload))
    : { teste: true, origem: 'flow-n8n-harness', quando: new Date().toISOString() };

  const slug = op.slug || definicao.name || 'ciclo';
  const { base } = n8n.exigirAmbiente();
  const rodada = abrirRodada({ slug, raiz, titulo: `Ciclo completo — ${definicao.name || slug}` });
  let criado = null;
  let ativadoAqui = false;
  let falhou = false;

  try {
    // 1. ambiente
    const sonda = await n8n.sondar();
    rodada.passo({ etapa: 'Sondar a instância', situacao: 'ok',
      arquivos: [rodada.salvarJson('sonda-da-instancia', { instancia: hostDe(base), ...sonda })],
      detalhe: `Credencial válida em \`${hostDe(base)}\`.` });

    // 2. padrões — avisa, não bloqueia
    const regras = padroes.conferir(definicao);
    const foraDoPadrao = regras.filter((r) => !r.ok);
    rodada.passo({ etapa: 'Conferir padrões', situacao: foraDoPadrao.length ? 'aviso' : 'ok',
      arquivos: [rodada.salvarJson('padroes', regras)],
      detalhe: foraDoPadrao.length
        ? `${foraDoPadrao.length} de ${regras.length} regra(s) fora do padrão: ` +
          foraDoPadrao.map((r) => `${r.regra} (${r.detalhe})`).join('; ') + '.'
        : `As ${regras.length} regras conferidas passaram.` });

    // 3. criar
    const sufixo = crypto.randomBytes(3).toString('hex');
    const { definicao: paraEnviar, trocas } = prepararParaTeste(definicao, sufixo);
    const enviado = rodada.salvarJson('workflow-enviado', paraEnviar);
    criado = await n8n.criarWorkflow(paraEnviar);
    const resposta = rodada.salvarJson('workflow-criado', criado);
    rodada.passo({ etapa: 'Criar o workflow', situacao: 'ok', arquivos: [enviado, resposta],
      detalhe: `Criado com id \`${criado.id}\`, inativo — como o n8n cria tudo.` +
        (trocas.length
          ? ` Path de webhook isolado nesta rodada: ${trocas.map((t) => `\`/${t.de}\` → \`/${t.para}\``).join(', ')}.`
          : '') });

    // 3. JSON canônico, já com o que o n8n normalizou
    const lido = await n8n.obterWorkflow(criado.id);
    rodada.passo({ etapa: 'Ler o workflow no n8n', situacao: 'ok',
      arquivos: [rodada.salvarJson('workflow-no-n8n', lido)],
      detalhe: `${(lido.nodes || []).length} nós, ${Object.keys(lido.connections || {}).length} com conexão de saída.` });

    const caminhoWebhook = n8n.caminhoDeWebhook(lido);

    // 4. teste
    if (!caminhoWebhook) {
      rodada.passo({ etapa: 'Disparar o workflow', situacao: 'pulado',
        detalhe: 'O workflow não tem nó de webhook, e a API pública do n8n não executa workflow. ' +
                 'Dispare pela ferramenta `test_workflow` do MCP e junte o JSON da execução a esta pasta.' });
    } else if (op.semAtivar) {
      rodada.passo({ etapa: 'Disparar o workflow', situacao: 'pulado',
        detalhe: `Pedido \`--sem-ativar\`: o webhook de produção \`/${caminhoWebhook}\` só responde com o workflow ativo.` });
    } else {
      const respostaAtivacao = await n8n.ativar(criado.id);
      ativadoAqui = true;
      const atendendo = await esperarAtivo(criado.id);
      rodada.passo({ etapa: 'Ativar para o teste', situacao: atendendo ? 'ok' : 'falhou',
        arquivos: [rodada.salvarJson('ativacao-para-teste', respostaAtivacao)],
        detalhe: 'Ativação **temporária**: o webhook de produção só responde ativo. A esteira desativa no fim. ' +
                 (atendendo
                   ? 'O n8n confirmou `active: true` antes do disparo.'
                   : 'O n8n não confirmou `active: true` na janela de espera.') });
      if (!atendendo) falhou = true;

      const envio = rodada.salvarJson('payload-enviado', { webhook: `/${caminhoWebhook}`, metodo: 'POST', corpo: payload });
      const chamada = await dispararComRepeticao({ caminhoWebhook, payload });
      const retorno = rodada.salvarJson('resposta-do-webhook', chamada);
      rodada.passo({
        etapa: 'Disparar o webhook',
        situacao: chamada.ok ? 'ok' : 'falhou',
        arquivos: [envio, retorno],
        detalhe: `\`POST /${caminhoWebhook}\` → HTTP ${chamada.status} em ${chamada.duracaoMs} ms` +
                 (chamada.tentativa > 1 ? `, na tentativa ${chamada.tentativa} (o n8n registra o webhook com atraso).` : '.'),
      });
      if (!chamada.ok) falhou = true;

      // 5. execução registrada
      const resumoExec = await esperarExecucao(criado.id);
      if (!resumoExec) {
        rodada.passo({ etapa: 'Ler a execução', situacao: 'falhou',
          detalhe: 'O n8n não registrou execução nenhuma para este workflow na janela de espera.' });
        falhou = true;
      } else {
        const completa = await n8n.execucao(resumoExec.id).catch((e) => ({ erro: e.message }));
        const arq = rodada.salvarJson('execucao-no-n8n', completa);
        const ok = completa?.status === 'success' || completa?.finished === true;
        rodada.passo({ etapa: 'Ler a execução', situacao: ok ? 'ok' : 'falhou', arquivos: [arq],
          detalhe: `Execução \`${resumoExec.id}\` — status \`${completa?.status || 'desconhecido'}\`. ` +
                   'O arquivo traz o dado que passou por cada nó.' });
        if (!ok) falhou = true;
      }
    }

    // 6. desativar ANTES dos prints: senão o canvas sai como "Published", um estado que o
    //    workflow não tem ao fim do ciclo, e a evidência mente (visto no training em 16/11).
    if (ativadoAqui) {
      if (!(await desativarDepoisDoTeste(rodada, criado.id))) falhou = true;
      ativadoAqui = false;
    }

    // 7. prints
    if (op.semPrints) {
      rodada.passo({ etapa: 'Prints de tela', situacao: 'pulado', detalhe: 'Pedido `--sem-prints`.' });
    } else if (!prints.temSessao(raiz)) {
      rodada.passo({ etapa: 'Prints de tela', situacao: 'aviso',
        detalhe: 'Sem sessão salva do editor. Rode `esteira login` (você digita a senha) e repita o ciclo para ter print.' });
    } else {
      try {
        const feitos = await prints.capturar({
          raiz,
          rodada,
          alvos: [
            { nome: 'canvas-do-workflow', caminhoUrl: `/workflow/${criado.id}`,
              esperarPor: ['[data-test-id="canvas-node"]', '.vue-flow__node', '[data-canvas-node-render-type]'] },
            { nome: 'lista-de-execucoes', caminhoUrl: `/workflow/${criado.id}/executions`,
              esperarPor: ['[data-test-id="execution-card"]', '[data-test-id="global-execution-list-item"]', '.el-empty'] },
          ],
        });
        rodada.passo({ etapa: 'Prints de tela', situacao: 'ok', arquivos: feitos.map((f) => f.arquivo),
          detalhe: 'Canvas e lista de execuções, capturados com a sessão que você autorizou.' });
      } catch (e) {
        rodada.passo({ etapa: 'Prints de tela', situacao: 'falhou', detalhe: e.message });
        falhou = true;
      }
    }
  } catch (e) {
    rodada.passo({ etapa: 'Ciclo', situacao: 'falhou', detalhe: e.message });
    falhou = true;
  } finally {
    // Rede de proteção: se algo estourou entre ativar e desativar, desativa aqui.
    if (ativadoAqui) {
      if (!(await desativarDepoisDoTeste(rodada, criado.id))) falhou = true;
      ativadoAqui = false;
    }
  }

  const indice = rodada.escreverIndice({
    instancia: hostDe(base),
    workflow: criado ? { id: criado.id, name: criado.name } : null,
    resumo: criado
      ? `O workflow \`${criado.id}\` está **criado e inativo**. Para publicar:\n\n` +
        '```bash\n' +
        `esteira.js publicar --id ${criado.id} --ok\n` +
        '```\n\n' +
        'Esse comando só roda com o seu OK — a esteira não publica por conta.'
      : 'Nada foi criado nesta rodada.',
  });

  console.log(`[esteira] ${falhou ? 'ciclo com falha' : 'ciclo completo'}`);
  if (criado) console.log(`[esteira] workflow: ${criado.id} (inativo)`);
  console.log(`[esteira] índice: ${indice}`);
  return falhou ? 5 : 0;
}

/**
 * Prepara o PROJETO que vai usar a esteira: garante que a sessão do editor e o `.env` não
 * sejam versionados, e diz quais variáveis preencher. Não escreve `.env` nenhum — a chave é
 * da pessoa, e arquivo de segredo não se cria por fora.
 */
async function comandoInit(op) {
  const raiz = path.resolve(op.raiz || process.cwd());
  const gitignore = path.join(raiz, '.gitignore');
  const precisam = ['.secrets/', '.env'];
  let atual = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf8') : '';
  const faltando = precisam.filter((linha) => !atual.split(/\r?\n/).includes(linha));
  if (faltando.length) {
    const bloco = (atual && !atual.endsWith('\n') ? '\n' : '') +
      '\n# flow-n8n-harness: sessão do editor e segredos\n' + faltando.join('\n') + '\n';
    fs.writeFileSync(gitignore, atual + bloco, 'utf8');
  }

  const pastaEvidencia = path.join(raiz, 'docs', 'evidencias');
  fs.mkdirSync(pastaEvidencia, { recursive: true });

  console.log(`[esteira] projeto preparado em ${raiz}`);
  console.log(`[esteira] .gitignore: ${faltando.length ? `acrescentei ${faltando.join(', ')}` : 'já cobria .secrets/ e .env'}`);
  console.log(`[esteira] evidência vai para ${path.relative(raiz, pastaEvidencia)}/`);
  console.log('[esteira] falta você criar o .env do projeto com duas linhas:');
  console.log('[esteira]   N8N_API_URL=   (a instância, sem /api/v1)');
  console.log('[esteira]   N8N_API_KEY=   (n8n → Settings → n8n API)');
  console.log('[esteira] depois: preparar · login · ciclo · publicar --ok');
  return 0;
}

async function comandoPrints(op) {
  if (!op.id) { console.error('[esteira] falta --id <workflow>.'); return 2; }
  const raiz = path.resolve(op.raiz || process.cwd());
  const { base } = n8n.exigirAmbiente();
  if (!prints.temSessao(raiz)) {
    console.error('[esteira] não há sessão salva do editor. Rode `esteira login` — quem digita a senha é você.');
    return 3;
  }
  const wf = await n8n.obterWorkflow(op.id);
  const rodada = abrirRodada({ slug: `prints-${op.id}`, raiz, titulo: `Prints do workflow ${wf.name || op.id}` });
  rodada.passo({ etapa: 'Estado do workflow', situacao: 'ok',
    arquivos: [rodada.salvarJson('workflow-no-n8n', wf)],
    detalhe: `\`${wf.name}\` está **${wf.active ? 'ativo' : 'inativo'}** no momento do print.` });

  const feitos = await prints.capturar({
    raiz,
    rodada,
    alvos: [
      { nome: 'canvas-do-workflow', caminhoUrl: `/workflow/${op.id}`,
        esperarPor: ['[data-test-id="canvas-node"]', '.vue-flow__node', '[data-canvas-node-render-type]'] },
      { nome: 'lista-de-execucoes', caminhoUrl: `/workflow/${op.id}/executions`,
        esperarPor: ['[data-test-id="execution-card"]', '[data-test-id="global-execution-list-item"]', '.el-empty'] },
    ],
  });
  rodada.passo({ etapa: 'Prints de tela', situacao: 'ok', arquivos: feitos.map((f) => f.arquivo),
    detalhe: 'Canvas e lista de execuções, com a sessão que você autorizou.' });
  const indice = rodada.escreverIndice({ instancia: hostDe(base), workflow: { id: op.id, name: wf.name } });
  console.log(`[esteira] ${feitos.length} print(s) gravados`);
  console.log(`[esteira] índice: ${indice}`);
  return 0;
}

async function comandoPublicar(op) {
  if (!op.id) { console.error('[esteira] falta --id <workflow>.'); return 2; }
  const raiz = path.resolve(op.raiz || process.cwd());
  const { base } = n8n.exigirAmbiente();

  if (!op.ok) {
    console.error('[esteira] publicar ATIVA o workflow na instância — e isso exige OK explícito.');
    console.error(`[esteira] instância: ${hostDe(base)} · workflow: ${op.id}`);
    console.error(`[esteira] com o OK da pessoa, repita com --ok:`);
    console.error(`[esteira]   esteira.js publicar --id ${op.id} --ok`);
    return 3;
  }

  const rodada = abrirRodada({ slug: `publicacao-${op.id}`, raiz, titulo: `Publicação do workflow ${op.id}` });
  const antes = await n8n.obterWorkflow(op.id);
  rodada.passo({ etapa: 'Estado antes', situacao: 'ok',
    arquivos: [rodada.salvarJson('workflow-antes', antes)],
    detalhe: `\`${antes.name}\` estava **${antes.active ? 'ativo' : 'inativo'}**.` });

  const depois = await n8n.ativar(op.id);
  rodada.passo({ etapa: 'Publicar (ativar)', situacao: depois?.active ? 'ok' : 'falhou',
    arquivos: [rodada.salvarJson('workflow-depois', depois)],
    detalhe: `Ativação pedida com OK da pessoa. Estado agora: **${depois?.active ? 'ativo' : 'inativo'}**.` });

  if (prints.temSessao(raiz)) {
    try {
      const feitos = await prints.capturar({ raiz, rodada,
        alvos: [{ nome: 'workflow-publicado', caminhoUrl: `/workflow/${op.id}`,
          esperarPor: ['[data-test-id="canvas-node"]', '.vue-flow__node'] }] });
      rodada.passo({ etapa: 'Print do publicado', situacao: 'ok', arquivos: feitos.map((f) => f.arquivo) });
    } catch (e) {
      rodada.passo({ etapa: 'Print do publicado', situacao: 'falhou', detalhe: e.message });
    }
  }

  const indice = rodada.escreverIndice({ instancia: hostDe(base), workflow: { id: op.id, name: antes.name } });
  console.log(`[esteira] publicado: ${op.id} (${depois?.active ? 'ativo' : 'NÃO ativou'})`);
  console.log(`[esteira] índice: ${indice}`);
  return depois?.active ? 0 : 5;
}

async function comandoLimpar(op) {
  if (!op.id) { console.error('[esteira] falta --id <workflow>.'); return 2; }
  if (!op.ok) {
    console.error(`[esteira] apagar é irreversível. Com o OK da pessoa: esteira.js limpar --id ${op.id} --ok`);
    return 3;
  }
  const antes = await n8n.obterWorkflow(op.id);
  if (antes.active) await n8n.desativar(op.id).catch(() => {});
  await n8n.apagarWorkflow(op.id);
  console.log(`[esteira] apagado: ${op.id} (${antes.name})`);
  return 0;
}

async function principal(argv) {
  const op = argumentos(argv.slice(2));
  carregarEnv(path.resolve(op.raiz || process.cwd()));
  const comando = op._[0] || 'preparar';
  const mesa = {
    init: comandoInit,
    preparar: comandoPreparar,
    login: comandoLogin,
    ciclo: comandoCiclo,
    prints: comandoPrints,
    publicar: comandoPublicar,
    limpar: comandoLimpar,
  };
  const fn = mesa[comando];
  if (!fn) {
    console.error(`[esteira] comando desconhecido: ${comando}`);
    console.error('[esteira] use: init | preparar | login | ciclo | prints | publicar | limpar');
    return 2;
  }
  return fn(op);
}

principal(process.argv)
  .then((codigo) => process.exit(codigo))
  .catch((e) => {
    if (e.code === 'AMBIENTE_INCOMPLETO' || e.code === 'PLAYWRIGHT_AUSENTE') {
      console.error(`[esteira] ${e.message}`);
      process.exit(4);
    }
    console.error(`[esteira] falhou: ${e.message}`);
    process.exit(5);
  });
