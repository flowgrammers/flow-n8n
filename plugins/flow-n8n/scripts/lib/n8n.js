'use strict';
/**
 * n8n.js — cliente mínimo da REST API pública do n8n, para a esteira.
 *
 * Duas decisões que valem explicação:
 *
 * 1. **Nenhuma instância embutida.** `N8N_API_URL` é obrigatória e não tem padrão. Uma URL
 *    default num kit de esteira é convite a criar workflow de teste na instância errada —
 *    e o estrago só aparece depois, com 500 workflows reais ao lado.
 *
 * 2. **A API pública do n8n não executa workflow.** Não existe `POST /workflows/{id}/run`.
 *    Quem dispara é o gatilho: webhook (HTTP), agenda, ou a ferramenta `test_workflow` do MCP.
 *    Por isso o passo de teste da esteira chama o webhook e depois LÊ a execução em
 *    `/executions` — é esse par (chamada + execução registrada) que vira evidência.
 *
 * A chave nunca é impressa, logada nem gravada em evidência. O módulo só a usa no header.
 */

const TEMPO_MS = 60000;

function exigirAmbiente() {
  const url = (process.env.N8N_API_URL || '').trim();
  const chave = (process.env.N8N_API_KEY || '').trim();
  const faltando = [];
  if (!url) faltando.push('N8N_API_URL');
  if (!chave) faltando.push('N8N_API_KEY');
  if (faltando.length) {
    const erro = new Error(
      `falta ${faltando.join(' e ')} no ambiente. Copie .env.example para .env e preencha; ` +
      'a chave sai em n8n → Settings → n8n API → Create an API key.'
    );
    erro.code = 'AMBIENTE_INCOMPLETO';
    throw erro;
  }
  return { base: url.replace(/\/+$/, ''), chave };
}

/** Faz a chamada e devolve { status, corpo }. Nunca inclui a chave no erro. */
async function chamar(metodo, caminho, corpo) {
  const { base, chave } = exigirAmbiente();
  const alvo = `${base}/api/v1${caminho}`;
  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), TEMPO_MS);
  let resposta;
  try {
    resposta = await fetch(alvo, {
      method: metodo,
      headers: {
        'X-N8N-API-KEY': chave,
        accept: 'application/json',
        ...(corpo === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
      signal: controle.signal,
    });
  } catch (e) {
    clearTimeout(relogio);
    // O host entra na mensagem porque "falhou na rede" sem dizer ONDE manda conferir
    // a coisa errada — e a instância é justamente o que a esteira não embute.
    let onde = base;
    try { onde = new URL(base).host; } catch { /* base malformada: vai como está */ }
    throw new Error(`${metodo} ${caminho} em ${onde} → falhou na rede: ${e.message}`);
  }
  clearTimeout(relogio);
  const texto = await resposta.text();
  let dados = null;
  if (texto.trim()) {
    try { dados = JSON.parse(texto); } catch { dados = { bruto: texto.slice(0, 4000) }; }
  }
  if (!resposta.ok) {
    const trecho = texto.slice(0, 600).replace(/\s+/g, ' ');
    throw new Error(`${metodo} ${caminho} → HTTP ${resposta.status}: ${trecho}`);
  }
  return dados;
}

/** Confere credencial e alcance sem escrever nada. */
async function sondar() {
  const { base } = exigirAmbiente();
  const dados = await chamar('GET', '/workflows?limit=1');
  return { base, alcancavel: true, workflowsVisiveis: Array.isArray(dados?.data) };
}

/**
 * Cria o workflow. O n8n recusa campos que ele mesmo devolve em leitura
 * (`id`, `active`, `tags`, `createdAt`…), então a definição é filtrada aqui:
 * passa só o que a API aceita na criação.
 */
async function criarWorkflow(definicao) {
  const aceitos = ['name', 'nodes', 'connections', 'settings', 'staticData'];
  const corpo = {};
  for (const k of aceitos) if (definicao[k] !== undefined) corpo[k] = definicao[k];
  if (!corpo.settings) corpo.settings = {};
  return chamar('POST', '/workflows', corpo);
}

const obterWorkflow = (id) => chamar('GET', `/workflows/${encodeURIComponent(id)}`);
const ativar = (id) => chamar('POST', `/workflows/${encodeURIComponent(id)}/activate`);
const desativar = (id) => chamar('POST', `/workflows/${encodeURIComponent(id)}/deactivate`);
const apagarWorkflow = (id) => chamar('DELETE', `/workflows/${encodeURIComponent(id)}`);

const execucoesDoWorkflow = (id, limite = 5) =>
  chamar('GET', `/executions?workflowId=${encodeURIComponent(id)}&limit=${limite}&includeData=false`);

const execucao = (id) =>
  chamar('GET', `/executions/${encodeURIComponent(id)}?includeData=true`);

/**
 * Dispara o workflow pelo webhook dele. `modo` é 'producao' ou 'teste':
 * `/webhook/<path>` só responde com o workflow ativo; `/webhook-test/<path>`
 * exige a aba do editor escutando, e por isso não serve para esteira sem humano.
 */
async function chamarWebhook({ caminhoWebhook, metodo = 'POST', payload, modo = 'producao' }) {
  const { base } = exigirAmbiente();
  const prefixo = modo === 'teste' ? 'webhook-test' : 'webhook';
  const alvo = `${base}/${prefixo}/${String(caminhoWebhook).replace(/^\/+/, '')}`;
  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), TEMPO_MS);
  const inicio = Date.now();
  let resposta;
  try {
    resposta = await fetch(alvo, {
      method: metodo,
      headers: payload === undefined ? {} : { 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: controle.signal,
    });
  } catch (e) {
    clearTimeout(relogio);
    throw new Error(`webhook ${alvo} → falhou na rede: ${e.message}`);
  }
  clearTimeout(relogio);
  const texto = await resposta.text();
  let corpo = null;
  if (texto.trim()) {
    try { corpo = JSON.parse(texto); } catch { corpo = { bruto: texto.slice(0, 4000) }; }
  }
  return {
    url: alvo,
    metodo,
    status: resposta.status,
    ok: resposta.ok,
    duracaoMs: Date.now() - inicio,
    corpo,
  };
}

/** Acha o primeiro nó de webhook e devolve o path configurado nele. */
function caminhoDeWebhook(workflow) {
  const nos = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const no = nos.find((n) => n.type === 'n8n-nodes-base.webhook');
  if (!no) return null;
  const p = no.parameters?.path;
  return typeof p === 'string' && p.trim() ? p.trim() : null;
}

module.exports = {
  exigirAmbiente,
  chamar,
  sondar,
  criarWorkflow,
  obterWorkflow,
  ativar,
  desativar,
  apagarWorkflow,
  execucoesDoWorkflow,
  execucao,
  chamarWebhook,
  caminhoDeWebhook,
};
