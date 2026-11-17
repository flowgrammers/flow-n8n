'use strict';
/**
 * padroes.js — confere a definição de um workflow contra as convenções da Flowgrammers e as
 * boas práticas do n8n, antes de ele ir para a instância.
 *
 * Avisa, não bloqueia: workflow fora do padrão ainda é testável, e quem decide publicar é a
 * pessoa. Mas o aviso fica gravado na evidência, então "estava fora do padrão" não some.
 *
 * As regras, e de onde vem cada uma:
 *   · descrição preenchida — convenção do n8n-workflows-production e boa prática oficial
 *     (é o campo que aparece na listagem e na busca do MCP);
 *   · sticky `📋 DOC` no canvas — convenção do n8n-workflows-production;
 *   · nome de workflow que não seja o padrão do editor ("My workflow 3");
 *   · nome de nó que descreva a ação, não o tipo ("Set1", "HTTP Request") — preferência
 *     gravada na instância e boa prática oficial;
 *   · webhook que responde por nó, com nó falível no caminho, precisa de tratamento de erro —
 *     senão quem chamou recebe 500 cru (n8n-error-handling-official).
 */

const STICKY = 'n8n-nodes-base.stickyNote';

/** Nomes que o editor dá sozinho. Seguidos ou não de número: "Webhook", "Set1", "Code 2". */
const NOMES_PADRAO = [
  'Webhook', 'Set', 'Edit Fields', 'Edit Fields (Set)', 'HTTP Request', 'Code', 'If', 'Switch',
  'Merge', 'Respond to Webhook', 'Schedule Trigger', 'Manual Trigger',
  "When clicking 'Execute workflow'", "When clicking 'Test workflow'", 'No Operation, do nothing',
  'Wait', 'Filter', 'Loop Over Items', 'Split Out', 'Aggregate', 'AI Agent', 'Execute Workflow',
  'Execute Workflow Trigger', 'When Executed by Another Workflow', 'Sticky Note',
];
const RE_NOME_PADRAO = new RegExp(
  `^(${NOMES_PADRAO.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*\\d*$`, 'i');

/** Tipos que costumam falhar em produção: rede, código, ou qualquer nó com credencial. */
function ehFalivel(no) {
  return /\.(httpRequest|code|function|functionItem)$/.test(no.type || '') ||
    (no.credentials && Object.keys(no.credentials).length > 0);
}

function temTratamentoDeErro(definicao, nos) {
  if (definicao.settings?.errorWorkflow) return true;
  return nos.some((n) => n.onError === 'continueErrorOutput');
}

/**
 * Devolve a lista de regras conferidas: { regra, ok, detalhe }.
 * Função pura sobre o JSON: não chama a instância.
 */
function conferir(definicao) {
  const nos = Array.isArray(definicao?.nodes) ? definicao.nodes : [];
  const reais = nos.filter((n) => n.type !== STICKY);
  const stickies = nos.filter((n) => n.type === STICKY);
  const regras = [];

  const nome = String(definicao?.name || '').trim();
  regras.push({
    regra: 'Nome do workflow descritivo',
    ok: Boolean(nome) && !/^my workflow\s*\d*$/i.test(nome),
    detalhe: nome ? `\`${nome}\`` : 'sem nome',
  });

  const descricao = String(definicao?.description || '').trim();
  regras.push({
    regra: 'Descrição preenchida',
    ok: descricao.length > 0,
    detalhe: descricao ? `${descricao.length} caracteres` : 'campo `description` vazio: diga o que faz e por quê',
  });

  const doc = stickies.find((s) => /📋\s*DOC/.test(String(s.parameters?.content || '')));
  regras.push({
    regra: 'Sticky `📋 DOC` no canvas',
    ok: Boolean(doc),
    detalhe: doc ? `em \`${doc.name}\`` : 'falta a nota com o que faz, gatilho, integrações e alertas',
  });

  const genericos = reais.filter((n) => RE_NOME_PADRAO.test(String(n.name || '').trim()));
  regras.push({
    regra: 'Nós com nome de ação, não de tipo',
    ok: genericos.length === 0,
    detalhe: genericos.length
      ? `nome padrão do editor em: ${genericos.map((n) => `\`${n.name}\``).join(', ')}`
      : `${reais.length} nó(s) conferidos`,
  });

  const responde = reais.some((n) => n.type === 'n8n-nodes-base.webhook' &&
    n.parameters?.responseMode === 'responseNode');
  const falivel = reais.some(ehFalivel);
  if (responde && falivel) {
    const tratado = temTratamentoDeErro(definicao, reais);
    regras.push({
      regra: 'Webhook que responde tem caminho de erro',
      ok: tratado,
      detalhe: tratado
        ? 'há `errorWorkflow` ou saída de erro ligada'
        : 'nó falível entre o webhook e a resposta, sem `onError: continueErrorOutput` nem `errorWorkflow`',
    });
  }

  return regras;
}

module.exports = { conferir, RE_NOME_PADRAO };
