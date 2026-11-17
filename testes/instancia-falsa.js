'use strict';
/**
 * instancia-falsa.js — um n8n de mentira, só com os endpoints que a esteira usa.
 *
 * Serve para exercitar o ciclo inteiro sem instância real e sem credencial: criar, ativar,
 * disparar o webhook, ler a execução, desativar. Duas fidelidades importam, e são o que dá
 * valor ao teste:
 *
 *   · exige o header `X-N8N-API-KEY` — se a esteira parar de mandar a chave, cai aqui;
 *   · o webhook de produção responde **404 com o workflow inativo**, como no n8n de verdade.
 *     É isso que prova que a ativação temporária do ciclo faz trabalho real, e não enfeite.
 */

const http = require('http');

function subir({ porta = 0 } = {}) {
  const workflows = new Map();
  const execucoes = [];
  let seqWf = 0;
  let seqExec = 0;

  const servidor = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    const caminho = url.pathname;
    let corpo = '';
    req.on('data', (p) => { corpo += p; });
    req.on('end', () => {
      const responder = (status, dados) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(dados));
      };
      const entrada = corpo ? JSON.parse(corpo) : null;
      const api = caminho.startsWith('/api/v1/');

      if (api && req.headers['x-n8n-api-key'] !== 'chave-da-instancia-falsa') {
        return responder(401, { message: 'unauthorized' });
      }

      // GET /api/v1/workflows
      if (api && caminho === '/api/v1/workflows' && req.method === 'GET') {
        return responder(200, { data: [...workflows.values()].slice(0, 1) });
      }

      // POST /api/v1/workflows
      if (api && caminho === '/api/v1/workflows' && req.method === 'POST') {
        if ('id' in (entrada || {})) return responder(400, { message: 'id is read-only' });
        const id = `wf-falso-${++seqWf}`;
        const wf = { id, active: false, createdAt: new Date().toISOString(), ...entrada };
        workflows.set(id, wf);
        return responder(200, wf);
      }

      const mWf = /^\/api\/v1\/workflows\/([^/]+)(\/(activate|deactivate))?$/.exec(caminho);
      if (api && mWf) {
        const wf = workflows.get(mWf[1]);
        if (!wf) return responder(404, { message: 'not found' });
        if (mWf[3] === 'activate' && req.method === 'POST') {
          // Como o n8n: dois workflows ativos não dividem o mesmo path de webhook.
          const paths = (w) => (w.nodes || []).filter((n) => n.type === 'n8n-nodes-base.webhook')
            .map((n) => n.parameters?.path);
          const meus = paths(wf);
          const choque = [...workflows.values()].some((o) => o.id !== wf.id && o.active &&
            paths(o).some((p) => meus.includes(p)));
          if (choque) return responder(409, { message: 'There is a conflict with one of the webhooks.' });
          wf.active = true;
          return responder(200, wf);
        }
        if (mWf[3] === 'deactivate' && req.method === 'POST') { wf.active = false; return responder(200, wf); }
        if (req.method === 'GET') return responder(200, wf);
        if (req.method === 'DELETE') { workflows.delete(wf.id); return responder(200, wf); }
      }

      // GET /api/v1/executions
      if (api && caminho === '/api/v1/executions' && req.method === 'GET') {
        const wfId = url.searchParams.get('workflowId');
        return responder(200, { data: execucoes.filter((e) => e.workflowId === wfId).reverse() });
      }

      const mExec = /^\/api\/v1\/executions\/([^/]+)$/.exec(caminho);
      if (api && mExec && req.method === 'GET') {
        const ex = execucoes.find((e) => e.id === mExec[1]);
        if (!ex) return responder(404, { message: 'not found' });
        return responder(200, { ...ex, data: ex.dadosDosNos });
      }

      // POST /webhook/<path>
      const mHook = /^\/webhook\/(.+)$/.exec(caminho);
      if (mHook) {
        const wf = [...workflows.values()].find((w) =>
          (w.nodes || []).some((n) => n.type === 'n8n-nodes-base.webhook' && n.parameters?.path === mHook[1]));
        if (!wf) return responder(404, { message: 'webhook não registrado' });
        if (!wf.active) {
          // Exatamente o que o n8n faz: webhook de produção não existe com workflow inativo.
          return responder(404, { message: 'The requested webhook is not registered' });
        }
        const id = `exec-falsa-${++seqExec}`;
        const eco = { recebido: entrada, ecoadoEm: new Date().toISOString(), origem: 'flow-n8n-harness' };
        execucoes.push({
          id,
          workflowId: wf.id,
          status: 'success',
          finished: true,
          mode: 'webhook',
          startedAt: new Date().toISOString(),
          // Um registro por nó real do workflow, com o nome que ELE deu — sticky não executa.
          dadosDosNos: Object.fromEntries((wf.nodes || [])
            .filter((n) => n.type !== 'n8n-nodes-base.stickyNote')
            .map((n) => [n.name, [{ json: n.type === 'n8n-nodes-base.webhook' ? { body: entrada } : eco }]])),
        });
        return responder(200, eco);
      }

      responder(404, { message: `sem rota para ${req.method} ${caminho}` });
    });
  });

  return new Promise((resolve) => {
    servidor.listen(porta, '127.0.0.1', () => {
      const { port } = servidor.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        chave: 'chave-da-instancia-falsa',
        workflows,
        execucoes,
        parar: () => new Promise((r) => servidor.close(r)),
      });
    });
  });
}

module.exports = { subir };
