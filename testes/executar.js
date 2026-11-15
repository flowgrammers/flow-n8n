#!/usr/bin/env node
'use strict';
/**
 * executar.js — a suíte do kit. Roda sem instância n8n e sem rede: o que ela prova é o
 * contrato, não a integração.
 *
 * O que está sob teste, e por que importa:
 *   · a redação de segredo — a evidência nasce publicável, ou o kit não serve;
 *   · o índice — passo sem arquivo e falha contada erradamente fazem a entrega mentir;
 *   · os códigos de saída — é por eles que o comando sabe quando parar;
 *   · o portão do `--ok` — publicar e apagar sem OK humano não pode nem começar.
 */

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const ESTEIRA = path.join(RAIZ, 'plugins', 'flow-n8n', 'scripts', 'lib', 'esteira.js');
const { redigir, abrirRodada, MARCA } = require(path.join(RAIZ, 'plugins/flow-n8n/scripts/lib/evidencia.js'));
const n8n = require(path.join(RAIZ, 'plugins/flow-n8n/scripts/lib/n8n.js'));

let passaram = 0;
const falhas = [];

function teste(nome, fn) {
  try {
    fn();
    passaram++;
    console.log(`  ok   ${nome}`);
  } catch (e) {
    falhas.push({ nome, erro: e.message });
    console.log(`  FALHOU ${nome}\n       ${e.message}`);
  }
}

/** Roda a esteira num processo próprio e devolve o código de saída. */
function rodar(args, ambiente = {}) {
  try {
    execFileSync(process.execPath, [ESTEIRA, ...args], {
      env: { ...process.env, N8N_API_URL: '', N8N_API_KEY: '', ...ambiente },
      stdio: 'pipe',
    });
    return 0;
  } catch (e) {
    return e.status === undefined ? -1 : e.status;
  }
}

/** Como `rodar`, mas devolve também o que o processo escreveu. */
function rodarComSaida(args, ambiente = {}) {
  try {
    const saida = execFileSync(process.execPath, [ESTEIRA, ...args], {
      env: { ...process.env, N8N_API_URL: '', N8N_API_KEY: '', ...ambiente },
      stdio: 'pipe',
    });
    return { codigo: 0, saida: String(saida) };
  } catch (e) {
    return {
      codigo: e.status === undefined ? -1 : e.status,
      saida: `${e.stdout || ''}${e.stderr || ''}`,
    };
  }
}

function pastaTemporaria() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'esteira-teste-'));
}

console.log('\nRedação de segredo');

teste('chave com nome sensível vira «redigido»', () => {
  const saida = redigir({ authorization: 'Bearer abc', senha: '123', nome: 'ana' });
  assert.strictEqual(saida.authorization, MARCA);
  assert.strictEqual(saida.senha, MARCA);
  assert.strictEqual(saida.nome, 'ana');
});

teste('valor igual ao segredo do ambiente é redigido mesmo em chave inocente', () => {
  const segredo = 'n8n_api_key_de_teste_1234567890';
  const saida = redigir({ observacao: `usei ${segredo} aqui` }, [segredo]);
  assert.ok(!saida.observacao.includes(segredo), 'o segredo sobreviveu na saída');
  assert.ok(saida.observacao.includes(MARCA));
});

teste('redação atravessa lista e objeto aninhado', () => {
  const saida = redigir({ nos: [{ parameters: { apiKey: 'xyz' } }] });
  assert.strictEqual(saida.nos[0].parameters.apiKey, MARCA);
});

teste('ciclo de referência não derruba a redação', () => {
  const a = { nome: 'raiz' };
  a.eu = a;
  const saida = redigir(a);
  assert.strictEqual(saida.nome, 'raiz');
  assert.strictEqual(saida.eu, '«ciclo»');
});

console.log('\nPasta e índice de evidência');

teste('a rodada nasce em docs/evidencias e numera os arquivos em ordem', () => {
  const raiz = pastaTemporaria();
  const r = abrirRodada({ slug: 'teste de rodada', raiz, titulo: 'Teste' });
  assert.ok(r.dir.includes(path.join('docs', 'evidencias')), 'a pasta não é docs/evidencias');
  const a = r.salvarJson('primeiro', { a: 1 });
  const b = r.salvarJson('segundo', { b: 2 });
  assert.ok(a.startsWith('01-'), `esperava prefixo 01, veio ${a}`);
  assert.ok(b.startsWith('02-'), `esperava prefixo 02, veio ${b}`);
  assert.ok(fs.existsSync(path.join(r.dir, a)));
});

teste('a chave da API não chega ao arquivo de evidência', () => {
  const raiz = pastaTemporaria();
  const antes = process.env.N8N_API_KEY;
  process.env.N8N_API_KEY = 'chave_secreta_do_teste_987654321';
  try {
    const r = abrirRodada({ slug: 'segredo', raiz });
    const arq = r.salvarJson('resposta', { eco: 'veio chave_secreta_do_teste_987654321 no corpo' });
    const texto = fs.readFileSync(path.join(r.dir, arq), 'utf8');
    assert.ok(!texto.includes('chave_secreta_do_teste_987654321'), 'a chave vazou para a evidência');
    assert.ok(texto.includes(MARCA));
  } finally {
    if (antes === undefined) delete process.env.N8N_API_KEY; else process.env.N8N_API_KEY = antes;
  }
});

teste('o índice conta as falhas e lista um passo por linha', () => {
  const raiz = pastaTemporaria();
  const r = abrirRodada({ slug: 'indice', raiz, titulo: 'Índice' });
  const arq = r.salvarJson('payload', { x: 1 });
  r.passo({ etapa: 'Criar', situacao: 'ok', arquivos: [arq] });
  r.passo({ etapa: 'Disparar', situacao: 'falhou', detalhe: 'HTTP 500' });
  const caminho = r.escreverIndice({ instancia: 'exemplo.invalid', workflow: { id: 'abc', name: 'wf' } });
  const texto = fs.readFileSync(caminho, 'utf8');
  assert.ok(texto.includes('1 passo(s) falharam'), 'não contou a falha');
  assert.ok(texto.includes('| 1 | Criar |'), 'faltou a linha do passo 1');
  assert.ok(texto.includes('| 2 | Disparar |'), 'faltou a linha do passo 2');
  assert.ok(texto.includes(`(./${arq})`), 'o índice não aponta para o arquivo gravado');
});

teste('duas rodadas no mesmo minuto não se sobrescrevem', () => {
  const raiz = pastaTemporaria();
  const a = abrirRodada({ slug: 'mesma', raiz });
  const b = abrirRodada({ slug: 'mesma', raiz });
  assert.notStrictEqual(a.dir, b.dir, 'a segunda rodada reusou a pasta da primeira');
  a.salvarJson('alvo', { quem: 'primeira' });
  b.salvarJson('alvo', { quem: 'segunda' });
  const primeira = JSON.parse(fs.readFileSync(path.join(a.dir, '01-alvo.json'), 'utf8'));
  assert.strictEqual(primeira.quem, 'primeira', 'a segunda rodada sobrescreveu a evidência da primeira');
});

console.log('\nLeitura do workflow');

teste('acha o caminho do webhook no exemplo que acompanha o kit', () => {
  const wf = JSON.parse(fs.readFileSync(path.join(RAIZ, 'plugins', 'flow-n8n', 'exemplos', 'eco.json'), 'utf8'));
  assert.strictEqual(n8n.caminhoDeWebhook(wf), 'flow-n8n-harness-eco');
});

teste('workflow sem webhook devolve nulo, em vez de inventar caminho', () => {
  assert.strictEqual(n8n.caminhoDeWebhook({ nodes: [{ type: 'n8n-nodes-base.set' }] }), null);
});

teste('a criação só envia os campos que a API aceita', () => {
  const aceitos = ['name', 'nodes', 'connections', 'settings', 'staticData'];
  const fonte = fs.readFileSync(path.join(RAIZ, 'plugins/flow-n8n/scripts/lib/n8n.js'), 'utf8');
  for (const campo of aceitos) assert.ok(fonte.includes(`'${campo}'`), `faltou ${campo} na lista`);
  assert.ok(!/const aceitos = \[[^\]]*'id'/.test(fonte), 'id não pode ir no POST de criação');
});

console.log('\nCódigos de saída e o portão do OK');

teste('publicar sem --ok sai com 3 e não ativa nada', () => {
  assert.strictEqual(rodar(['publicar', '--id', 'abc123'], { N8N_API_URL: 'https://exemplo.invalid', N8N_API_KEY: 'x'.repeat(20) }), 3);
});

teste('limpar sem --ok sai com 3', () => {
  assert.strictEqual(rodar(['limpar', '--id', 'abc123'], { N8N_API_URL: 'https://exemplo.invalid', N8N_API_KEY: 'x'.repeat(20) }), 3);
});

teste('ambiente sem N8N_API_URL sai com 4', () => {
  // --raiz numa pasta vazia de propósito: sem isso o teste leria o .env de quem rodou a
  // suíte e passaria por acidente. Foi o que aconteceu quando o kit ganhou .env de verdade.
  assert.strictEqual(rodar(['preparar', '--raiz', pastaTemporaria()]), 4);
});

teste('comando desconhecido sai com 2', () => {
  assert.strictEqual(rodar(['dancar'], { N8N_API_URL: 'https://exemplo.invalid', N8N_API_KEY: 'x'.repeat(20) }), 2);
});

teste('ciclo sem --spec sai com 2', () => {
  assert.strictEqual(rodar(['ciclo'], { N8N_API_URL: 'https://exemplo.invalid', N8N_API_KEY: 'x'.repeat(20) }), 2);
});

console.log('\nCarregamento do .env');

teste('o .env do projeto entra no ambiente (sem ele, a esteira sairia com 4)', () => {
  const raiz = pastaTemporaria();
  fs.writeFileSync(path.join(raiz, '.env'),
    'N8N_API_URL=http://127.0.0.1:9\nN8N_API_KEY=chave_de_teste_1234567890\n');
  // Porta 9 (discard) recusa a conexão: sair 5 prova que a esteira TENTOU chamar,
  // ou seja, leu a URL do arquivo. Se não tivesse lido, sairia 4 por ambiente incompleto.
  assert.strictEqual(rodar(['preparar', '--raiz', raiz]), 5);
});

teste('variável do ambiente vence o .env, e a chave ainda vem do arquivo', () => {
  const raiz = pastaTemporaria();
  fs.writeFileSync(path.join(raiz, '.env'),
    'N8N_API_URL=http://nao-deve-usar.invalid\nN8N_API_KEY=chave_de_teste_1234567890\n');
  const r = rodarComSaida(['preparar', '--raiz', raiz], { N8N_API_URL: 'http://127.0.0.1:9' });
  // Sair 5 (e não 4) prova que a CHAVE veio do arquivo. Qual URL foi usada, quem conta é a
  // evidência: é ela que grava a instância sondada.
  assert.strictEqual(r.codigo, 5);
  const base = path.join(raiz, 'docs', 'evidencias');
  const rodadas = fs.readdirSync(base);
  assert.strictEqual(rodadas.length, 1, 'esperava uma rodada de evidência');
  const sonda = JSON.parse(fs.readFileSync(path.join(base, rodadas[0], '01-sonda-da-instancia.json'), 'utf8'));
  assert.strictEqual(sonda.instancia, '127.0.0.1:9', `a evidência aponta ${sonda.instancia}`);
  assert.ok(String(sonda.erro).includes('127.0.0.1:9'), 'o erro gravado não diz onde falhou');
});

teste('.env vazio não vale como preenchido', () => {
  const raiz = pastaTemporaria();
  fs.writeFileSync(path.join(raiz, '.env'), 'N8N_API_URL=\nN8N_API_KEY=\n');
  assert.strictEqual(rodar(['preparar', '--raiz', raiz]), 4);
});

console.log(`\n${passaram} passaram, ${falhas.length} falharam\n`);
process.exit(falhas.length ? 1 : 0);
