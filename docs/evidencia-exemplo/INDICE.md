# Evidência — Ciclo completo — [esteira] eco de webhook

> **Exemplo, não entrega.** Gerado contra a instância falsa de `testes/instancia-falsa.js`,
> só para mostrar o formato. Nenhum n8n real foi tocado, e o host `127.0.0.1` abaixo é o
> servidor de teste local que sobe durante a suíte.
Rodada `2026-11-15-0001-esteira-eco-de-webhook` · gerada pela esteira do `flow-n8n-harness`.

- **Instância n8n**: 127.0.0.1:50587
- **Workflow**: `wf-falso-1` — [esteira] eco de webhook
- **Passos registrados**: 8
- **Resultado**: todos os passos passaram

O workflow `wf-falso-1` está **criado e inativo**. Para publicar:

```bash
esteira.js publicar --id wf-falso-1 --ok
```

Esse comando só roda com o seu OK — a esteira não publica por conta.

## Passos

| # | Etapa | Situação | Evidência |
|---|---|---|---|
| 1 | Sondar a instância | ✅ ok | [`01-sonda-da-instancia.json`](./01-sonda-da-instancia.json) |
| 2 | Criar o workflow | ✅ ok | [`02-workflow-enviado.json`](./02-workflow-enviado.json) · [`03-workflow-criado.json`](./03-workflow-criado.json) |
| 3 | Ler o workflow no n8n | ✅ ok | [`04-workflow-no-n8n.json`](./04-workflow-no-n8n.json) |
| 4 | Ativar para o teste | ✅ ok | [`05-ativacao-para-teste.json`](./05-ativacao-para-teste.json) |
| 5 | Disparar o webhook | ✅ ok | [`06-payload-enviado.json`](./06-payload-enviado.json) · [`07-resposta-do-webhook.json`](./07-resposta-do-webhook.json) |
| 6 | Ler a execução | ✅ ok | [`08-execucao-no-n8n.json`](./08-execucao-no-n8n.json) |
| 7 | Prints de tela | ⏭️ pulado | — |
| 8 | Desativar depois do teste | ✅ ok | — |

## Detalhe por passo

### Sondar a instância

Credencial válida em `127.0.0.1:50587`.

### Criar o workflow

Criado com id `wf-falso-1`, inativo — como o n8n cria tudo.

### Ler o workflow no n8n

3 nós, 2 com conexão de saída.

### Ativar para o teste

Ativação **temporária**: o webhook de produção só responde ativo. A esteira desativa no fim. O n8n confirmou `active: true` antes do disparo.

### Disparar o webhook

`POST /flow-n8n-harness-eco` → HTTP 200 em 1 ms.

### Ler a execução

Execução `exec-falsa-1` — status `success`. O arquivo traz o dado que passou por cada nó.

### Prints de tela

Pedido `--sem-prints`.

### Desativar depois do teste

Workflow de volta a inativo. Publicar é passo separado, e exige o seu OK.

---

Segredos não entram nesta pasta: a chave da API e todo campo com nome de credencial
saem como «redigido» antes da gravação. Por isso a evidência nasce publicável.
